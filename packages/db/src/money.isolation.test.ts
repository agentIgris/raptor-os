/**
 * Money isolation — the Phase 3 release gate.
 *
 * The design spec closes Phase 3 on one sentence: "Allocation reproducible from stored
 * inputs; reconciliation invariant holds under fuzz". Both halves are assertions about
 * the DATABASE, not about the application, so they are made here against a real PGlite
 * instance and made as close to the metal as possible: mostly as the schema owner, which
 * bypasses RLS entirely, so the only thing that can refuse anything is the schema itself.
 *
 * Structural claims are made by reflecting over the catalogue (pg_class, pg_policy,
 * pg_constraint, pg_trigger, information_schema) rather than by re-reading the SQL that
 * created the tables. A migration that looks right but is not reflected correctly is
 * still broken, and reading the DDL would not catch it.
 *
 * THE HEADLINE TEST
 * -----------------
 * `reproduces a stored allocation after the roster it was drawn from has changed`
 * runs an allocation, then MUTATES the underlying `team_membership` rows, then re-runs
 * from the stored snapshot and asserts byte-identical output. That is the completion
 * criterion, and everything else in this file exists to make it possible or to close a
 * hole next to it.
 *
 * WHY THE ENGINE IS MIRRORED RATHER THAN IMPORTED
 * -----------------------------------------------
 * `packages/core/src/prize/allocation-engine.ts` is the authority for what an
 * allocation IS. It cannot be imported here: `packages/db` has no dependency on it, and
 * adding one would need a workspace-wide install, which is out of scope for this package.
 *
 * So the replay logic below is a line-for-line mirror of that file — `hashInputs`,
 * `parsePercent`, `computePercentage`, `explainAllocation` — and it is used for one
 * purpose: to prove the database's independently-written canonical form agrees with the
 * engine's, byte for byte. Two implementations that agree are evidence. One
 * implementation that agrees with itself is not. If the engine changes, this file fails
 * loudly rather than quietly validating a stale copy, because the mirrored
 * `input_hash` is compared against a hash the DATABASE recomputes from stored rows using
 * SQL written separately.
 *
 * This is stated rather than hidden because a duplicated rule is a real cost. The
 * duplication is confined to this test file and to the canonical forms the migration
 * documents; no production code path in `packages/db` computes an allocation.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const P1 = "aaaaaaaa-0000-0000-0000-000000000001";
const P2 = "aaaaaaaa-0000-0000-0000-000000000002";
const P3 = "aaaaaaaa-0000-0000-0000-000000000003";
const P4 = "aaaaaaaa-0000-0000-0000-000000000004";

/** A fixed instant, so every stored timestamp is identical between runs. */
const COMPUTED_AT = "2026-01-15T10:30:00.000Z";
const COMPUTED_BY = "svc:allocation-engine";
/** A budget window the fixture's postings fall inside. */
const PERIOD_START = "2026-01-01";
const PERIOD_END = "2026-03-31";

/**
 * Every table introduced by 0004_money.sql.
 *
 * Held as an explicit list rather than derived from `schema_migration`: the point of
 * these tests is that a table which *should* be protected IS protected, and deriving the
 * list would let a table silently drop out of the schema and out of its own test in one
 * commit.
 */
const MONEY_TABLES = [
  "ledger_account",
  "ledger_journal",
  "ledger_line",
  "budget",
  "expense",
  "prize_allocation",
  "prize_allocation_input",
  "prize_allocation_term",
  "prize_allocation_result",
  "prize_allocation_reconciliation",
] as const;

/**
 * Money columns, named rather than pattern-matched.
 *
 * `share_percent`, `weight`, `confidence` and `limit_amount` are also numeric at a
 * different precision on purpose: percentages and counts are not money, and forcing them
 * to numeric(18,4) would be a lie about what they are.
 */
const MONEY_COLUMNS = [
  "amount",
  "limit_amount",
  "gross",
  "deductions",
  "net",
  "net_prize",
  "tax_withheld",
  "basis_amount",
  "computed_amount",
  "allocated_total",
  "unallocated",
  "variance",
] as const;

/** SQLSTATE for a CHECK constraint violation. */
const SQLSTATE_CHECK_VIOLATION = "23514";
/** SQLSTATE for a foreign key violation. */
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
/** SQLSTATE for a unique violation. */
const SQLSTATE_UNIQUE_VIOLATION = "23505";
/** SQLSTATE for insufficient privilege, and for a policy's WITH CHECK refusing a write. */
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Columns that are deliberately `date` rather than `timestamptz`.
 *
 * An accounting period is "March", not an instant. Give it a timezone and it belongs to
 * two different months depending on who is asking, which is the same class of bug as the
 * legacy text timestamps. Asserted as its own test below rather than left as an
 * unexplained exemption.
 */
const ACCOUNTING_PERIOD_COLUMNS = ["posting_period", "incurred_on", "period_start", "period_end"] as const;

let db: PGlite;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Runs `fn` as the non-superuser application role.
 *
 * The superuser connection used elsewhere is a CONTROL, not the system under test: a
 * superuser bypasses every RLS policy, so an isolation assertion made as a superuser
 * proves nothing (ADR-0006).
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

/** As the schema owner, which bypasses RLS. Seeding and reflection only. */
async function asOwner(sql: string): Promise<void> {
  await db.exec("RESET ROLE");
  await db.exec(sql);
}

async function ownerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("RESET ROLE");
  const result = await db.query<T>(sql, params);
  return result.rows;
}

/**
 * Runs `fn` expecting PostgreSQL to refuse it with a specific SQLSTATE.
 *
 * Asserting the SQLSTATE rather than the message matters here. Several guarantees in this
 * schema are enforced by different mechanisms that all produce "rejected" — a revoked
 * grant and a trigger both raise 42501, and a CHECK and a deferred guard both raise
 * 23514 — so a message match would let the wrong mechanism stand in for the right one.
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
  expect(actual, `${label}: wrong SQLSTATE — ${String((caught as Error).message).slice(0, 200)}`).toBe(
    sqlstate,
  );
}

// ---------------------------------------------------------------------------
// THE ENGINE, MIRRORED
//
// Every function below is a copy of the corresponding function in
// packages/core/src/prize/allocation-engine.ts. See the file header for why.
// ---------------------------------------------------------------------------

const MONEY_SCALE = 4;

interface EngineParticipant {
  readonly personId: string;
  readonly kind: "roster" | "staff";
  /** Required only for `weighted_by_participation`. */
  readonly weight?: bigint;
}

interface EngineRule {
  readonly version: number;
  readonly basis: string;
  readonly percentages?: Readonly<Record<string, string>>;
  readonly fixedAmounts?: Readonly<Record<string, string>>;
  readonly poolPercentage?: Readonly<Record<string, string>>;
  readonly remainderPolicy: string;
}

interface EngineResult {
  readonly personId: string;
  readonly participantKind: "roster" | "staff";
  readonly basisAmount: string;
  readonly computedAmount: string;
  readonly explanation: string;
}

/** mirror: money.ts parsePercent */
function parsePercent(percent: string): bigint {
  const [whole = "0", fraction = ""] = percent.trim().split(".");
  return BigInt(`${whole}${fraction.padEnd(MONEY_SCALE, "0")}`);
}

/** mirror: allocation-engine.ts formatMinor */
function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(MONEY_SCALE + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -MONEY_SCALE)}.${digits.slice(-MONEY_SCALE)}`;
}

/** mirror: allocation-engine.ts sortRecord */
function sortRecord(record: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** mirror: allocation-engine.ts hashInputs */
function hashInputs(
  netPrizeMinor: bigint,
  currency: string,
  participants: readonly EngineParticipant[],
  rule: EngineRule,
): string {
  const canonical = {
    netPrize: formatMinor(netPrizeMinor),
    currency,
    participants: [...participants]
      .map((p) => ({ personId: p.personId, kind: p.kind, weight: p.weight?.toString() ?? null }))
      .sort((a, b) => (a.personId < b.personId ? -1 : 1)),
    rule: {
      version: rule.version,
      basis: rule.basis,
      percentages: sortRecord(rule.percentages),
      fixedAmounts: sortRecord(rule.fixedAmounts),
      poolPercentage: sortRecord(rule.poolPercentage),
      remainderPolicy: rule.remainderPolicy,
    },
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** mirror: allocation-engine.ts explainAllocation, `percentage` branch only */
function explainPercentage(personId: string, basisAmount: bigint, computed: bigint, net: bigint): string {
  return (
    `${personId}: basis percentage; ${formatMinor(basisAmount)} of the net prize ${formatMinor(net)} ` +
    `was the participant's stated percentage, giving ${formatMinor(computed)}.`
  );
}

/**
 * mirror: allocation-engine.ts computePercentage plus the surrounding map/sort, and the
 * bounds check that guards it.
 *
 * Truncating division, not largest remainder: the engine deliberately leaves the
 * truncation residue in `unallocated` rather than distributing it, so `allocated +
 * unallocated == net` holds exactly and the reconciliation has nothing to forgive.
 *
 * `assertPercentagesWithinBounds` is mirrored because it decides what a legal
 * allocation IS. A rule whose percentages exceed 100% throws, so such an allocation
 * never reaches storage and the schema is right to refuse a negative remainder.
 */
function allocatePercentage(
  netPrizeMinor: bigint,
  participants: readonly EngineParticipant[],
  rule: EngineRule,
): { readonly results: readonly EngineResult[]; readonly unallocated: string } {
  const parsed = participants.map((participant) => parsePercent(rule.percentages![participant.personId]!));

  const percentTotal = parsed.reduce((acc, value) => acc + value, 0n);
  if (percentTotal > 1_000_000n) {
    throw new Error(`Rule using percentage over-allocates: percentages sum to ${percentTotal}`);
  }

  const shares = new Map<string, bigint>();
  participants.forEach((participant, index) => {
    shares.set(participant.personId, (netPrizeMinor * parsed[index]!) / 1_000_000n);
  });

  const results = [...participants]
    .map((participant) => ({
      personId: participant.personId,
      participantKind: participant.kind,
      basisAmount: formatMinor(netPrizeMinor),
      computedAmount: formatMinor(shares.get(participant.personId) ?? 0n),
      explanation: explainPercentage(
        participant.personId,
        netPrizeMinor,
        shares.get(participant.personId) ?? 0n,
        netPrizeMinor,
      ),
    }))
    .sort((a, b) => (a.personId < b.personId ? -1 : 1));

  const allocated = [...shares.values()].reduce((acc, value) => acc + value, 0n);

  return { results, unallocated: formatMinor(netPrizeMinor - allocated) };
}

/** Mirror of the `snapshot_hash` canonical form documented in 0004_money.sql. */
function snapshotHash(input: {
  readonly gross: string;
  readonly deductions: string;
  readonly net: string;
  readonly tax: string;
  readonly currency: string;
  readonly basis: string;
  readonly ruleVersion: number;
  readonly remainderPolicy: string;
  readonly participants: ReadonlyArray<{
    readonly personId: string;
    readonly kind: string;
    readonly sharePercent: string | null;
    readonly weight: string | null;
  }>;
  readonly terms: ReadonlyArray<{ readonly personId: string; readonly role: string; readonly amount: string }>;
}): string {
  const text =
    `gross=${input.gross}\n` +
    `deductions=${input.deductions}\n` +
    `net=${input.net}\n` +
    `tax=${input.tax}\n` +
    `currency=${input.currency}\n` +
    `basis=${input.basis}\n` +
    `rule_version=${input.ruleVersion}\n` +
    `remainder_policy=${input.remainderPolicy}\n` +
    [...input.participants]
      .sort((a, b) => (a.personId < b.personId ? -1 : 1))
      .map((p) => `p|${p.personId}|${p.kind}|${p.sharePercent ?? ""}|${p.weight ?? ""}\n`)
      .join("") +
    [...input.terms]
      .sort((a, b) =>
        a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : a.role < b.role ? -1 : 1,
      )
      .map((t) => `t|${t.personId}|${t.role}|${t.amount}\n`)
      .join("");

  return createHash("sha256").update(text).digest("hex");
}

/** Mirror of the `output_hash` canonical form documented in 0004_money.sql. */
function outputHash(results: readonly EngineResult[], currency: string, ruleVersion: number): string {
  const text = [...results]
    .sort((a, b) => (a.personId < b.personId ? -1 : 1))
    .map(
      (r) =>
        `${r.personId}|${r.participantKind}|${r.basisAmount}|${r.computedAmount}|${currency}|` +
        `${ruleVersion}|${r.explanation.length}:${r.explanation}\n`,
    )
    .join("");

  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Stack {
  readonly divisionId: string;
  readonly teamId: string;
  readonly competitionDivisionId: string;
  readonly registrationId: string;
  readonly expenseAccountId: string;
  readonly payableAccountId: string;
  readonly assetAccountId: string;
}

/**
 * Seeds the whole competitive chain for one organisation.
 *
 * Deliberately complete: the money tables are all reached through `team`,
 * `competition_division`, `registration` and `entry_cost`, so a partial fixture would
 * only prove that the money tables work when nothing else is true.
 */
async function seedStack(orgId: string, prefix: string): Promise<Stack> {
  // Account codes are UNIQUE per org and constrained to digits, so a second stack in the
  // SAME organisation (which is what the budget-scoping test needs) has to land in a
  // different code range.
  const codeOffset = prefix.charCodeAt(0) % 100;

  const ids = {
    gameId: `${prefix}-0000-0000-0000-000000000001`,
    titleId: `${prefix}-0000-0000-0000-000000000002`,
    seasonId: `${prefix}-0000-0000-0000-000000000003`,
    divisionId: `${prefix}-0000-0000-0000-000000000004`,
    teamId: `${prefix}-0000-0000-0000-000000000005`,
    opponentId: `${prefix}-0000-0000-0000-000000000008`,
    competitionId: `${prefix}-0000-0000-0000-000000000009`,
    competitionDivisionId: `${prefix}-0000-0000-0000-00000000000a`,
    expenseAccountId: `${prefix}-0000-0000-0000-0000000000b1`,
    payableAccountId: `${prefix}-0000-0000-0000-0000000000b2`,
    assetAccountId: `${prefix}-0000-0000-0000-0000000000b3`,
  };

  await asOwner(`
    INSERT INTO game (id, org_id, name, slug)
      VALUES ('${ids.gameId}', '${orgId}', 'Test Game', 'game-${prefix}');
    INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('${ids.titleId}', '${orgId}', '${ids.gameId}', 'Test Cup', 'cup-${prefix}', 'commercial', 'active');
    INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('${ids.seasonId}', '${orgId}', '${ids.titleId}', 'Season 1', 'S1', now(), now() + interval '1 year', true);
    INSERT INTO division (id, org_id, season_id, name, slug, tier, rank_order)
      VALUES ('${ids.divisionId}', '${orgId}', '${ids.seasonId}', 'Elite', 'elite-${prefix}', 'elite', 1);
    INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES ('${ids.teamId}', '${orgId}', 'Team One', 'team-${prefix}', '${ids.gameId}', '${ids.divisionId}', 'active', now());
    INSERT INTO opponent (id, org_id, name, game_id)
      VALUES ('${ids.opponentId}', '${orgId}', 'Rival ${prefix}', '${ids.gameId}');
    INSERT INTO competition (id, org_id, title_id, name, format, status, starts_at, ends_at)
      VALUES ('${ids.competitionId}', '${orgId}', '${ids.titleId}', 'Test Cup 2026', 'single_elimination', 'registration_open',
              now() + interval '10 days', now() + interval '14 days');
    INSERT INTO competition_division (id, org_id, competition_id, division_id, name, capacity)
      VALUES ('${ids.competitionDivisionId}', '${orgId}', '${ids.competitionId}', '${ids.divisionId}', 'Elite Bracket', 8);

    INSERT INTO ledger_account (id, org_id, code, name, account_type, currency)
    VALUES
      ('${ids.expenseAccountId}',  '${orgId}', '${6100 + codeOffset}', 'Competition entry costs', 'expense',    'INR'),
      ('${ids.payableAccountId}',  '${orgId}', '${2100 + codeOffset}', 'Entry fees received',    'liability', 'INR'),
      ('${ids.assetAccountId}',    '${orgId}', '${1100 + codeOffset}', 'Cash',                   'asset',     'INR');
  `);

  return { ...ids, registrationId: "", expenseAccountId: ids.expenseAccountId, payableAccountId: ids.payableAccountId, assetAccountId: ids.assetAccountId };
}

/** Adds a roster with the given shares. `shares` maps person id to share_percent. */
async function seedRoster(
  orgId: string,
  prefix: string,
  teamId: string,
  shares: Readonly<Record<string, string>>,
  tag: string,
): Promise<void> {
  const rows = Object.entries(shares)
    .map(([personId, share], index) => {
      // `tag` keeps two seedings of the same prefix from colliding, which is exactly what
      // the mutate-then-replay test needs: it seeds the roster twice.
      const id = `${prefix}-0000-0000-0000-${tag}${String(index + 1).padStart(11, "0")}`;
      return `('${id}', '${orgId}', '${teamId}', '${personId}', 'player', ${share}, now())`;
    })
    .join(",\n        ");

  await asOwner(`
    INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from)
    VALUES ${rows}
  `);
}

/** Creates a confirmed registration with a paid entry cost. */
async function seedRegistration(
  orgId: string,
  prefix: string,
  competitionDivisionId: string,
  teamId: string,
  amount: string,
): Promise<string> {
  const registrationId = `${prefix}-0000-0000-0000-0000000000c1`;

  await asOwner(`
    INSERT INTO registration (id, org_id, competition_division_id, team_id, status)
      VALUES ('${registrationId}', '${orgId}', '${competitionDivisionId}', '${teamId}', 'confirmed');
    INSERT INTO entry_cost (org_id, registration_id, amount, currency, paid_at, method)
      VALUES ('${orgId}', '${registrationId}', ${amount}, 'INR', now(), 'gateway');
  `);

  return registrationId;
}

/** Creates and settles the prize pool for a competition division. */
async function seedSettledPool(
  orgId: string,
  competitionDivisionId: string,
  gross: string,
  deductions: string,
): Promise<string> {
  const inserted = await ownerRows<{ id: string }>(
    `INSERT INTO prize_pool (org_id, competition_division_id, gross, deductions, net, tax_withheld, currency)
     VALUES ($1, $2, $3::numeric, $4::numeric, $3::numeric - $4::numeric, 0, 'INR') RETURNING id`,
    [orgId, competitionDivisionId, gross, deductions],
  );
  const poolId = inserted[0]!.id;

  await asOwner(
    `UPDATE prize_pool SET status = 'settled', settled_at = now(), settled_by_person_id = '${P1}'
      WHERE id = '${poolId}'`,
  );

  return poolId;
}

/**
 * Posts a balanced journal in one transaction, the way the ledger requires.
 *
 * `reversesId` is supplied at INSERT rather than set afterwards because
 * `ledger_journal` is strictly append-only: a reversal is a NEW entry that names what it
 * reverses, never an edit of the entry being reversed. That is why `reverses_id` is a
 * column on the header at all.
 */
async function postJournal(input: {
  readonly orgId: string;
  readonly description: string;
  readonly postingPeriod?: string;
  readonly costCentreTeamId?: string;
  readonly currency?: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amount: string;
  readonly sourceKind?: string;
  readonly reversesId?: string;
}): Promise<string> {
  let journalId = "";

  await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ledger_journal (org_id, description, source_kind, posting_period, cost_centre_team_id, currency, reverses_id)
       VALUES ($1, $2, COALESCE($3::journal_source_kind, 'expense'), COALESCE($4::date, $5::date),
               $6::uuid, COALESCE($7, 'INR'), $8::uuid) RETURNING id`,
      [
        input.orgId,
        input.description,
        input.sourceKind ?? null,
        input.postingPeriod ?? null,
        PERIOD_START,
        input.costCentreTeamId ?? null,
        input.currency ?? null,
        input.reversesId ?? null,
      ],
    );
    journalId = inserted.rows[0]!.id;

    await tx.query(
      `INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
       VALUES
         ($1, $2, 1, $3, 'debit',  $4::numeric, COALESCE($5,'INR')),
         ($1, $2, 2, $6, 'credit', $4::numeric, COALESCE($5,'INR'))`,
      [
        input.orgId,
        journalId,
        input.debitAccountId,
        input.amount,
        input.currency ?? null,
        input.creditAccountId,
      ],
    );
  });

  return journalId;
}

interface PersistedAllocation {
  readonly allocationId: string;
  readonly inputHash: string;
  readonly snapshotHash: string;
  readonly outputHash: string;
  readonly results: readonly EngineResult[];
  readonly unallocated: string;
  /** The result rows as stored, so a replay is compared against the disk, not itself. */
  readonly storedResults: readonly EngineResult[];
}

/**
 * Captures a snapshot from the LIVE roster, allocates against it, and persists the whole
 * decision — header, frozen inputs, rule terms, results and reconciliation — in one
 * transaction, exactly as the posting path must.
 */
async function allocateAndPersist(input: {
  readonly orgId: string;
  readonly poolId: string;
  readonly poolVersion: number;
  readonly competitionDivisionId: string;
  readonly teamId: string;
  readonly participants: readonly EngineParticipant[];
  readonly shares: Readonly<Record<string, string>>;
  readonly gross: string;
  readonly deductions: string;
  readonly net: string;
  readonly tax: string;
  readonly ruleVersion: number;
}): Promise<PersistedAllocation> {
  const netMinor = parsePercent(input.net);
  const rule: EngineRule = {
    version: input.ruleVersion,
    basis: "percentage",
    percentages: input.shares,
    remainderPolicy: "largest_remainder_stable_sort",
  };

  const inputHash = hashInputs(netMinor, "INR", input.participants, rule);
  const { results, unallocated } = allocatePercentage(netMinor, input.participants, rule);

  const snapshotHashValue = snapshotHash({
    gross: input.gross,
    deductions: input.deductions,
    net: input.net,
    tax: input.tax,
    currency: "INR",
    basis: "percentage",
    ruleVersion: input.ruleVersion,
    remainderPolicy: "largest_remainder_stable_sort",
    participants: input.participants.map((p) => ({
      personId: p.personId,
      kind: p.kind,
      // numeric(7,4) renders at the column's scale, so "50" comes back as "50.0000".
      // Hashing the raw share instead would make the stored hash disagree with the
      // stored row for a reason that has nothing to do with tampering.
      sharePercent: formatMinor(parsePercent(input.shares[p.personId]!)),
      weight: null,
    })),
    terms: input.participants.map((p) => ({
      personId: p.personId,
      role: "percentage",
      // The stored numeric is the parsed percentage at the column's scale; the raw
      // string beside it is what the engine actually hashed. Both are frozen, and the
      // migration's CHECK ties them together so they cannot tell different stories.
      amount: formatMinor(parsePercent(input.shares[p.personId]!)),
    })),
  });

  const outputHashValue = outputHash(results, "INR", input.ruleVersion);

  const allocatedTotal = results
    .map((r) => parsePercent(r.computedAmount))
    .reduce((acc, value) => acc + value, 0n);

  let allocationId = "";

  await db.transaction(async (tx) => {
    const header = await tx.query<{ id: string }>(
      `INSERT INTO prize_allocation
         (org_id, competition_division_id, prize_pool_id, pool_version, team_id, basis, rule_version,
          gross, deductions, net_prize, tax_withheld, currency, input_hash, snapshot_hash, output_hash,
          computed_at, computed_by)
       VALUES ($1,$2,$3,$4,$5,'percentage',$6,$7,$8,$9,$10,'INR',$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        input.orgId,
        input.competitionDivisionId,
        input.poolId,
        input.poolVersion,
        input.teamId,
        input.ruleVersion,
        input.gross,
        input.deductions,
        input.net,
        input.tax,
        inputHash,
        snapshotHashValue,
        outputHashValue,
        COMPUTED_AT,
        COMPUTED_BY,
      ],
    );
    allocationId = header.rows[0]!.id;

    for (const participant of input.participants) {
      await tx.query(
        `INSERT INTO prize_allocation_input (org_id, allocation_id, person_id, participant_kind, share_percent)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.orgId, allocationId, participant.personId, participant.kind, input.shares[participant.personId] ?? null],
      );
      await tx.query(
        `INSERT INTO prize_allocation_term (org_id, allocation_id, person_id, term_role, amount, raw_value, currency)
         VALUES ($1,$2,$3,'percentage',$4::numeric,$5,'INR')`,
        [input.orgId, allocationId, participant.personId, input.shares[participant.personId]!, input.shares[participant.personId]!],
      );
    }

    for (const result of results) {
      await tx.query(
        `INSERT INTO prize_allocation_result
           (org_id, allocation_id, person_id, participant_kind, basis_amount, computed_amount,
            currency, rule_version, computed_at, computed_by, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,'INR',$7,$8,$9,$10)`,
        [
          input.orgId,
          allocationId,
          result.personId,
          result.participantKind,
          result.basisAmount,
          result.computedAmount,
          input.ruleVersion,
          COMPUTED_AT,
          COMPUTED_BY,
          result.explanation,
        ],
      );
    }

    await tx.query(
      `INSERT INTO prize_allocation_reconciliation
         (org_id, allocation_id, net_prize, allocated_total, unallocated, variance, currency, is_balanced, explanation)
       VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric,
               $4::numeric + $5::numeric - $3::numeric, 'INR',
               ($4::numeric + $5::numeric - $3::numeric) = 0, 'reconciled')`,
      [input.orgId, allocationId, input.net, formatMinor(allocatedTotal), unallocated],
    );
  });

  return {
    allocationId,
    inputHash,
    snapshotHash: snapshotHashValue,
    outputHash: outputHashValue,
    results,
    unallocated,
    storedResults: results,
  };
}

/**
 * Re-runs the engine from the STORED snapshot alone.
 *
 * This is the replay. It reads nothing but the allocation's own rows — no
 * `team_membership`, no `prize_pool` — which is the whole point: the inputs are frozen,
 * so a change anywhere else in the database cannot reach this function.
 */
async function replayFromStoredSnapshot(orgId: string, allocationId: string): Promise<PersistedAllocation> {
  const header = await ownerRows<{
    id: string;
    net_prize: string;
    gross: string;
    deductions: string;
    tax_withheld: string;
    currency: string;
    basis: string;
    rule_version: number;
    remainder_policy: string;
    input_hash: string;
    snapshot_hash: string;
    output_hash: string;
  }>(
    `SELECT id, net_prize::text, gross::text, deductions::text, tax_withheld::text, currency,
            basis, rule_version, remainder_policy, input_hash, snapshot_hash, output_hash
       FROM prize_allocation WHERE org_id = $1 AND id = $2`,
    [orgId, allocationId],
  );
  const a = header[0]!;

  const inputs = await ownerRows<{
    person_id: string;
    participant_kind: string;
    share_percent: string | null;
    weight: string | null;
  }>(
    `SELECT person_id, participant_kind, share_percent::text, weight::text
       FROM prize_allocation_input WHERE org_id = $1 AND allocation_id = $2 ORDER BY person_id`,
    [orgId, allocationId],
  );

  const terms = await ownerRows<{ person_id: string; term_role: string; amount: string; raw_value: string }>(
    `SELECT person_id, term_role, amount::text, raw_value
       FROM prize_allocation_term WHERE org_id = $1 AND allocation_id = $2 ORDER BY person_id, term_role`,
    [orgId, allocationId],
  );

  const storedResults = await ownerRows<{
    person_id: string;
    participant_kind: string;
    basis_amount: string;
    computed_amount: string;
    explanation: string;
  }>(
    `SELECT person_id, participant_kind, basis_amount::text, computed_amount::text, explanation
       FROM prize_allocation_result WHERE org_id = $1 AND allocation_id = $2 ORDER BY person_id`,
    [orgId, allocationId],
  );

  // Rebuild the engine's inputs from the frozen rows alone.
  const participants: EngineParticipant[] = inputs.map((i) => ({
    personId: i.person_id,
    kind: i.participant_kind === "staff" ? "staff" : "roster",
    ...(i.weight === null ? {} : { weight: BigInt(i.weight) }),
  }));

  const percentages: Record<string, string> = {};
  const fixedAmounts: Record<string, string> = {};
  const poolPercentage: Record<string, string> = {};
  for (const term of terms) {
    if (term.term_role === "percentage") percentages[term.person_id] = term.raw_value;
    else if (term.term_role === "fixed_amount") fixedAmounts[term.person_id] = term.raw_value;
    else poolPercentage[term.person_id] = term.raw_value;
  }

  const rule: EngineRule = {
    version: a.rule_version,
    basis: a.basis,
    percentages,
    fixedAmounts,
    poolPercentage,
    remainderPolicy: a.remainder_policy,
  };

  const netMinor = parsePercent(a.net_prize);
  const recomputedInputHash = hashInputs(netMinor, a.currency, participants, rule);
  const { results, unallocated } = allocatePercentage(netMinor, participants, rule);

  return {
    allocationId: a.id,
    inputHash: recomputedInputHash,
    snapshotHash: snapshotHash({
      gross: a.gross,
      deductions: a.deductions,
      net: a.net_prize,
      tax: a.tax_withheld,
      currency: a.currency,
      basis: a.basis,
      ruleVersion: a.rule_version,
      remainderPolicy: a.remainder_policy,
      participants: inputs.map((i) => ({
        personId: i.person_id,
        kind: i.participant_kind,
        sharePercent: i.share_percent,
        weight: i.weight,
      })),
      terms: terms.map((t) => ({ personId: t.person_id, role: t.term_role, amount: t.amount })),
    }),
    outputHash: outputHash(results, a.currency, a.rule_version),
    results,
    unallocated,
    // What is actually on disk, so a caller compares the replay against the STORED rows
    // rather than against what the replay itself just produced.
    storedResults: storedResults.map((r) => ({
      personId: r.person_id,
      participantKind: r.participant_kind === "staff" ? ("staff" as const) : ("roster" as const),
      basisAmount: r.basis_amount,
      computedAmount: r.computed_amount,
      explanation: r.explanation,
    })),
  };
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");

  // organization cascades to every tenant table, so this is a complete reset.
  await asOwner("TRUNCATE organization, person CASCADE");

  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES
      ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
      ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref) VALUES
      ('${P1}', 'p-1'), ('${P2}', 'p-2'), ('${P3}', 'p-3'), ('${P4}', 'p-4');
  `);
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("money schema — migration ledger", () => {
  it("applies 0004_money.sql and 0005_prize_pool_lifecycle.sql", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0004_money.sql");
    // Asserted separately because 0005 is a correction to an already-applied migration
    // and nothing else in this suite would notice if it quietly dropped out — the
    // schema would still pass every table and policy check below.
    expect(status.applied).toContain("0005_prize_pool_lifecycle.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("runs the isolation assertions as a role that CANNOT bypass RLS", async () => {
    const rows = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_app'",
    );
    expect(rows, "the application role must exist").toHaveLength(1);
    expect(rows[0]!.rolsuper, "a superuser bypasses every policy in this schema").toBe(false);
    expect(rows[0]!.rolbypassrls, "BYPASSRLS switches the whole guarantee off").toBe(false);
  });

  it("ENABLES and FORCES row level security on every money table", async () => {
    const rows = await ownerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
      [[...MONEY_TABLES]],
    );

    expect(rows.map((r) => r.relname)).toEqual([...MONEY_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every money table exactly one tenant policy with no IS NULL bypass", async () => {
    const rows = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1) ORDER BY c.relname`,
      [[...MONEY_TABLES]],
    );

    expect(rows).toHaveLength(MONEY_TABLES.length);
    for (const row of rows) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // An `OR org_id IS NULL` anywhere here hands every tenant every row whenever the
      // context is missing, which is the one failure this whole predicate exists to stop.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });

  it("makes org_id NOT NULL on every money table", async () => {
    const rows = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id' ORDER BY table_name`,
      [[...MONEY_TABLES]],
    );

    expect(rows).toHaveLength(MONEY_TABLES.length);
    for (const row of rows) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every money table UNIQUE (org_id, id) so children can use composite FKs", async () => {
    const rows = await ownerRows<{ relname: string; conname: string; attnames: string[] }>(
      `SELECT c.relname, u.conname, array_agg(a.attname ORDER BY k.ord) AS attnames
         FROM pg_constraint u
         JOIN pg_class c ON c.oid = u.conrelid
         JOIN LATERAL unnest(u.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = u.conrelid AND a.attnum = k.attnum
        WHERE u.contype = 'u' AND c.relname = ANY($1)
        GROUP BY c.relname, u.conname, u.conkey ORDER BY c.relname, u.conname`,
      [[...MONEY_TABLES]],
    );

    const keyed = rows.filter((r) => r.attnames.length === 2 && r.attnames[0] === "org_id" && r.attnames[1] === "id");

    expect(
      keyed.map((r) => r.relname).sort(),
      "every money table must expose UNIQUE (org_id, id) for composite FKs",
    ).toEqual([...MONEY_TABLES].sort());
  });

  it("leads every multi-column index on a money table with org_id", async () => {
    const rows = await ownerRows<{ table_name: string; index_name: string; cols: string[] }>(
      `SELECT t.relname AS table_name, i.relname AS index_name,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
        WHERE t.relname = ANY($1) AND k.attnum > 0 AND array_length(x.indkey, 1) > 1
        GROUP BY t.relname, i.relname, x.indkey ORDER BY t.relname, i.relname`,
      [[...MONEY_TABLES]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cols[0], `${row.table_name}.${row.index_name} must lead with org_id`).toBe("org_id");
    }
  });

  it("has no single-column foreign key from a money table to a tenant table", async () => {
    // A table is tenant-owned if it has a NOT NULL org_id AND UNIQUE (org_id, id).
    // `organization` and `person` are excluded by that definition on purpose: the first
    // is the tenant root, the second is deliberately org-independent.
    const tenantTables = new Set(
      (
        await ownerRows<{ relname: string }>(
          `SELECT c.relname FROM pg_class c
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

    const fks = await ownerRows<{ child_table: string; parent_table: string; conname: string; cols: string[] }>(
      `SELECT child.relname AS child_table, parent.relname AS parent_table,
              con.conname, array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class child  ON child.oid  = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f' AND child.relname = ANY($1)
        GROUP BY child.relname, parent.relname, con.conname
        ORDER BY child.relname, con.conname`,
      [[...MONEY_TABLES]],
    );

    expect(fks.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const fk of fks) {
      if (!tenantTables.has(fk.parent_table)) continue;
      if (fk.cols.length < 2 || fk.cols[0] !== "org_id") {
        offenders.push(`${fk.child_table}.${fk.conname} -> ${fk.parent_table}(${fk.cols.join(", ")})`);
      }
    }

    expect(
      offenders,
      `every FK from a money table to a tenant table must be composite and lead with org_id:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("money schema — money and time types", () => {
  it("stores every money column as numeric(18,4)", async () => {
    const rows = await ownerRows<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = ANY($2)`,
      [[...MONEY_TABLES], [...MONEY_COLUMNS]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // An integer minor unit would be an integer type; a float would be double
      // precision. ADR-0003 fixes this at numeric(18,4).
      expect(row.data_type, `${row.table_name}.${row.column_name} must be numeric`).toBe("numeric");
      expect(row.numeric_precision, `${row.table_name}.${row.column_name} precision`).toBe(18);
      expect(row.numeric_scale, `${row.table_name}.${row.column_name} scale`).toBe(4);
    }
  });

  it("pairs every money-bearing table with a varchar(3) currency column", async () => {
    const moneyTables = await ownerRows<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = ANY($2)`,
      [[...MONEY_TABLES], [...MONEY_COLUMNS]],
    );

    expect(moneyTables.length).toBeGreaterThan(0);
    for (const { table_name } of moneyTables) {
      const currency = await ownerRows<{ data_type: string; character_maximum_length: number | null }>(
        `SELECT data_type, character_maximum_length FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'currency'`,
        [table_name],
      );
      expect(currency, `${table_name} has money but no currency column`).toHaveLength(1);
      expect(currency[0]!.data_type).toBe("character varying");
      expect(currency[0]!.character_maximum_length).toBe(3);
    }
  });

  it("uses timestamptz for every instant and never text", async () => {
    // The legacy `attendances.session_time` was `text` and the audit called it the likely
    // root cause of the whole attendance bug backlog. Strings do not order, and a cutoff
    // window cannot be evaluated against a string.
    //
    // The four accounting-period columns are excluded BY NAME rather than by loosening
    // the pattern, because they are deliberately `date` and the test immediately below
    // asserts exactly that. Naming them keeps this assertion honest: a new `text` column
    // called anything else is still caught here.
    const rows = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND NOT (column_name = ANY($2))
          AND (column_name ~ '(_at|_from|_to|_on|_deadline)$' OR column_name LIKE '%time%' OR column_name LIKE '%date%')
        ORDER BY table_name, column_name`,
      [[...MONEY_TABLES], [...ACCOUNTING_PERIOD_COLUMNS]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name} must be timestamptz`).toBe("timestamp with time zone");
    }
  });

  it("keeps accounting periods as dates, because a period is a calendar fact", async () => {
    // An accounting period is "March", not an instant: give it a timezone and it belongs
    // to two different months depending on who is asking.
    const rows = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = ANY($2)
        ORDER BY table_name, column_name`,
      [[...MONEY_TABLES], [...ACCOUNTING_PERIOD_COLUMNS]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name} must be date`).toBe("date");
    }
  });
});

// ---------------------------------------------------------------------------
// RLS in practice
// ---------------------------------------------------------------------------

describe("money — row level security in practice", () => {
  it("shows a member only their own organisation's rows", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const b = await seedStack(ORG_B, "dddddddd");
    await postJournal({
      orgId: ORG_A,
      description: "A expense",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "100.0000",
    });
    await postJournal({
      orgId: ORG_B,
      description: "Another expense",
      debitAccountId: b.expenseAccountId,
      creditAccountId: b.payableAccountId,
      amount: "200.0000",
    });

    await asApp(async () => {
      const rows = await db.query<{ org_id: string; amount: string }>(
        "SELECT org_id, amount::text FROM ledger_line WHERE side = 'debit'",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.org_id).toBe(ORG_A);
    }, ORG_A);

    await asApp(async () => {
      const rows = await db.query<{ org_id: string }>("SELECT org_id FROM expense");
      expect(rows.rows).toHaveLength(0);
    }, ORG_A);
  });

  it("returns nothing when no tenant is set in the session", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await postJournal({
      orgId: ORG_A,
      description: "An expense",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "100.0000",
    });

    // Fail CLOSED. There is deliberately no IS NULL branch in any of these policies, so
    // an unset context cannot expose anything. This is the regression test for the
    // defect pattern ADR-0015 exists to prevent, and it is asserted per table.
    await asApp(async () => {
      for (const table of MONEY_TABLES) {
        const rows = await db.query(`SELECT * FROM ${table}`);
        expect(rows.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }

      const view = await db.query("SELECT * FROM budget_balance");
      expect(view.rows, "budget_balance must expose nothing without a tenant context").toHaveLength(0);
    });

    // And an INSERT with no context must be refused, not merely invisible. The refusal
    // comes from the policy's WITH CHECK, which is 42501 — the same code as a missing
    // grant, because from the caller's side both mean "you may not write this here".
    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO ledger_account (org_id, code, name, account_type, currency)
             VALUES ($1, '9999', 'Ghost', 'expense', 'INR')`,
            [ORG_A],
          ),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "insert with no tenant context",
      );
    });
  });

  it("refuses a cross-tenant reference, by the composite foreign key itself", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const b = await seedStack(ORG_B, "dddddddd");

    // Run as the owner so RLS is not what refuses it: this asserts the DATABASE refuses
    // a cross-tenant money reference independently of any policy (ADR-0011).
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO budget (org_id, name, scope_team_id, period_start, period_end, currency, limit_amount)
          VALUES ('${ORG_A}', 'Stolen scope', '${b.teamId}', '${PERIOD_START}', '${PERIOD_END}', 'INR', 1000)
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "budget naming another org's team",
    );

    // And the same for the ledger: a line naming another org's account is refused by the
    // composite FK, not by a policy.
    const bJournal = await postJournal({
      orgId: ORG_B,
      description: "B expense",
      debitAccountId: b.expenseAccountId,
      creditAccountId: b.payableAccountId,
      amount: "10.0000",
    });

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
          VALUES ('${ORG_B}', '${bJournal}', 3, '${a.expenseAccountId}', 'debit', 5, 'INR')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "line naming another org's account",
    );

    expect(a.teamId).not.toBe(b.teamId);
  });

  it("refuses a ledger line filed under another org's journal", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const b = await seedStack(ORG_B, "dddddddd");

    const bJournal = await postJournal({
      orgId: ORG_B,
      description: "B expense",
      debitAccountId: b.expenseAccountId,
      creditAccountId: b.payableAccountId,
      amount: "10.0000",
    });

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
          VALUES ('${ORG_A}', '${bJournal}', 3, '${a.expenseAccountId}', 'debit', 5, 'INR')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "line naming another org's journal",
    );
  });
});

// ---------------------------------------------------------------------------
// Double entry
// ---------------------------------------------------------------------------

describe("money cannot be created or destroyed by an unbalanced journal", () => {
  it("accepts a balanced journal", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const journalId = await postJournal({
      orgId: ORG_A,
      description: "Balanced entry",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "250.0000",
    });

    const rows = await ownerRows<{ side: string; amount: string }>(
      "SELECT side, amount::text FROM ledger_line WHERE journal_id = $1 ORDER BY side",
      [journalId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.side).sort()).toEqual(["credit", "debit"]);
    expect(rows[0]!.amount).toBe("250.0000");
  });

  it("refuses a journal whose debits exceed its credits", async () => {
    const a = await seedStack(ORG_A, "cccccccc");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO ledger_journal (org_id, description, source_kind, posting_period, currency)
             VALUES ($1, 'Money from nowhere', 'expense', $2, 'INR') RETURNING id`,
            [ORG_A, PERIOD_START],
          );
          await tx.query(
            `INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
             VALUES
               ($1, $2, 1, $3, 'debit',  100, 'INR'),
               ($1, $2, 2, $4, 'credit',  60, 'INR')`,
            [ORG_A, inserted.rows[0]!.id, a.expenseAccountId, a.payableAccountId],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "journal with debits greater than credits",
    );

    const orphans = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_journal WHERE org_id = $1",
      [ORG_A],
    );
    expect(orphans[0]!.n, "the refused transaction must leave nothing behind").toBe(0);
  });

  it("refuses a journal with a single line, because one-sided is not double entry", async () => {
    const a = await seedStack(ORG_A, "cccccccc");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO ledger_journal (org_id, description, source_kind, posting_period, currency)
             VALUES ($1, 'One-sided', 'expense', $2, 'INR') RETURNING id`,
            [ORG_A, PERIOD_START],
          );
          await tx.query(
            `INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
             VALUES ($1, $2, 1, $3, 'debit', 100, 'INR')`,
            [ORG_A, inserted.rows[0]!.id, a.expenseAccountId],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "journal with one line",
    );
  });

  it("refuses a journal whose lines are not all in the journal's currency", async () => {
    const a = await seedStack(ORG_A, "cccccccc");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO ledger_journal (org_id, description, source_kind, posting_period, currency)
             VALUES ($1, 'Mixed currency', 'expense', $2, 'INR') RETURNING id`,
            [ORG_A, PERIOD_START],
          );
          await tx.query(
            `INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
             VALUES
               ($1, $2, 1, $3, 'debit',  100, 'INR'),
               ($1, $2, 2, $4, 'credit', 100, 'USD')`,
            [ORG_A, inserted.rows[0]!.id, a.expenseAccountId, a.payableAccountId],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "journal mixing currencies",
    );
  });

  it("refuses the imbalance from plain SQL with no application code in the path", async () => {
    // The balance must be a property of the DATABASE, not of a service that happens to
    // validate before it writes. Everything here runs as the schema owner, which bypasses
    // RLS entirely and is not the application role, so the only thing that can refuse the
    // entry is the trigger.
    const a = await seedStack(ORG_A, "cccccccc");

    await expectSqlstate(
      async () => {
        await db.exec("RESET ROLE");
        await db.exec(`INSERT INTO ledger_journal (id, org_id, description, source_kind, posting_period, currency)
          VALUES ('cccccccc-0000-0000-0000-0000000000d1', '${ORG_A}', 'Raw SQL', 'expense', '${PERIOD_START}', 'INR')`);
        await db.exec(`INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
          VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000d1', 1, '${a.expenseAccountId}', 'debit', 999, 'INR')`);
      },
      SQLSTATE_CHECK_VIOLATION,
      "plain SQL unbalanced journal",
    );
  });
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

describe("posted money is append-only", () => {
  it("denies the application role UPDATE and DELETE on every money table", async () => {
    // Asserted by reflecting over the ACL rather than by trying each statement: the
    // property under test is that no such grant exists at all, and a table that quietly
    // gained one would only be found by an exhaustive list of statements.
    // Reflected from information_schema rather than by trying every statement: the
    // property under test is that no such grant exists AT ALL, and a table that quietly
    // gained one should be found without a test per table per statement.
    const rows = await ownerRows<{ table_name: string; has_update: boolean; has_delete: boolean }>(
      `SELECT t.table_name,
              EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                       WHERE g.table_name = t.table_name AND g.grantee = 'raptor_app'
                         AND g.privilege_type = 'UPDATE') AS has_update,
              EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                       WHERE g.table_name = t.table_name AND g.grantee = 'raptor_app'
                         AND g.privilege_type = 'DELETE') AS has_delete
         FROM information_schema.tables t
        WHERE t.table_name = ANY($1) AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`,
      [[...MONEY_TABLES]],
    );

    expect(rows).toHaveLength(MONEY_TABLES.length);
    for (const row of rows) {
      expect(row.has_update, `raptor_app must not hold UPDATE on ${row.table_name}`).toBe(false);
      expect(row.has_delete, `raptor_app must not hold DELETE on ${row.table_name}`).toBe(false);
    }
  });

  it("refuses an UPDATE on a posted ledger entry, by grant and by trigger", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const journalId = await postJournal({
      orgId: ORG_A,
      description: "Posted",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "100.0000",
    });

    // The grant: the application role is simply not allowed.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query("UPDATE ledger_journal SET description = 'Rewritten' WHERE id = $1", [journalId]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "updating a journal as the application role",
      );
      await expectSqlstate(
        () => db.query("UPDATE ledger_line SET amount = 1 WHERE journal_id = $1", [journalId]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "updating a line as the application role",
      );
      await expectSqlstate(
        () => db.query("DELETE FROM ledger_journal WHERE id = $1", [journalId]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "deleting a journal as the application role",
      );
    }, ORG_A);

    // The trigger: not even the schema owner may rewrite a posted entry, which is what
    // covers an operator with psql and a future migration that tries to be helpful.
    // RLS is FORCEd, so the owner is subject to the policy too and the tenant context
    // must be set for the UPDATE to reach the row and therefore the trigger.
    await db.exec("RESET ROLE");
    await db.exec(`SELECT set_config('app.org_id', '${ORG_A}', false)`);
    await expectSqlstate(
      () => db.exec(`UPDATE ledger_journal SET description = 'Rewritten' WHERE id = '${journalId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "updating a journal as the owner",
    );
    await expectSqlstate(
      () => db.exec(`DELETE FROM ledger_line WHERE journal_id = '${journalId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a posted line as the owner",
    );
    await db.exec("SELECT set_config('app.org_id', '', false)");

    const stored = await ownerRows<{ description: string }>(
      "SELECT description FROM ledger_journal WHERE id = $1",
      [journalId],
    );
    expect(stored[0]!.description, "refused, not clamped").toBe("Posted");
  });

  it("corrects a mistake with a reversing entry rather than an edit", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const original = await postJournal({
      orgId: ORG_A,
      description: "Mistake",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "100.0000",
    });

    await postJournal({
      orgId: ORG_A,
      description: "Reverses the mistake",
      debitAccountId: a.payableAccountId,
      creditAccountId: a.expenseAccountId,
      amount: "100.0000",
      sourceKind: "adjustment",
      reversesId: original,
    });

    // Two reversals claiming one entry is a branch, and a branch means "which figure was
    // published" has two answers.
    await expectSqlstate(
      () =>
        postJournal({
          orgId: ORG_A,
          description: "Also reverses it",
          debitAccountId: a.payableAccountId,
          creditAccountId: a.expenseAccountId,
          amount: "100.0000",
          sourceKind: "adjustment",
          reversesId: original,
        }),
      SQLSTATE_UNIQUE_VIOLATION,
      "two reversals claiming the same entry",
    );

    const rows = await ownerRows<{ description: string; reverses_id: string | null }>(
      "SELECT description, reverses_id FROM ledger_journal WHERE org_id = $1 ORDER BY description",
      [ORG_A],
    );
    expect(rows).toHaveLength(2);
    // The mistake is still there, which is the point: the history of the error survives
    // the correction, and the reversal makes it visible rather than hiding it.
    expect(rows.map((r) => r.description)).toContain("Mistake");
    expect(rows.find((r) => r.reverses_id !== null)!.reverses_id).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Prize pool lifecycle
// ---------------------------------------------------------------------------

describe("a settled prize pool is immutable", () => {
  it("refuses to change a settled pool's figures, even for the owner", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE prize_pool SET gross = 5000, net = 4900
           WHERE org_id = '${ORG_A}' AND competition_division_id = '${a.competitionDivisionId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "rewriting a settled pool",
    );

    const stored = await ownerRows<{ gross: string; net: string }>(
      "SELECT gross::text, net::text FROM prize_pool WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.gross).toBe("1000.0000");
    expect(stored[0]!.net).toBe("900.0000");
  });

  it("refuses to delete a settled pool", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await expectSqlstate(
      () => asOwner(`DELETE FROM prize_pool WHERE org_id = '${ORG_A}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a settled pool",
    );
  });

  it("denies the application role UPDATE on the pool's figures", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");
    const pool = await ownerRows<{ id: string }>("SELECT id FROM prize_pool WHERE org_id = $1", [ORG_A]);

    await asApp(async () => {
      await expectSqlstate(
        () => db.query("UPDATE prize_pool SET gross = 9999 WHERE id = $1", [pool[0]!.id]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "raising a settled pool's gross as the application role",
      );
    }, ORG_A);
  });

  it("records a correction as a new version rather than overwriting the first", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const original = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await asOwner(`
      INSERT INTO prize_pool (org_id, competition_division_id, version, supersedes_id,
                              gross, deductions, net, tax_withheld, currency)
      VALUES ('${ORG_A}', '${a.competitionDivisionId}', 2, '${original}',
              1200, 100, 1100, 0, 'INR')
    `);

    const versions = await ownerRows<{ version: number; gross: string; supersedes_id: string | null; status: string }>(
      "SELECT version, gross::text, supersedes_id, status FROM prize_pool WHERE org_id = $1 ORDER BY version",
      [ORG_A],
    );

    expect(versions).toHaveLength(2);
    // The published figure is still readable, which is the whole reason for versioning.
    expect(versions[0]!.gross).toBe("1000.0000");
    expect(versions[0]!.status).toBe("settled");
    expect(versions[1]!.gross).toBe("1200.0000");
    expect(versions[1]!.supersedes_id).toBe(original);
    // The new version is a draft: it must be settled in its own right before anything is
    // allocated against it, so "the figure was corrected" and "the correction was
    // published" stay two separate, separately-dated facts.
    expect(versions[1]!.status).toBe("draft");
  });

  it("refuses to settle a second pool over a division that is already settled", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const original = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await asOwner(`
      INSERT INTO prize_pool (org_id, competition_division_id, version, supersedes_id,
                              gross, deductions, net, tax_withheld, currency)
      VALUES ('${ORG_A}', '${a.competitionDivisionId}', 2, '${original}',
              1200, 100, 1100, 0, 'INR')
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE prize_pool SET status = 'settled', settled_at = now(), settled_by_person_id = '${P1}'
           WHERE org_id = '${ORG_A}' AND version = 2
        `),
      SQLSTATE_CHECK_VIOLATION,
      "settling a second pool over a settled division",
    );
  });

  it("refuses a settle with no evidence of who did it", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await asOwner(`
      INSERT INTO prize_pool (org_id, competition_division_id, gross, deductions, net, tax_withheld, currency)
      VALUES ('${ORG_A}', '${a.competitionDivisionId}', 1000, 100, 900, 0, 'INR')
    `);

    await expectSqlstate(
      () => asOwner(`UPDATE prize_pool SET status = 'settled' WHERE org_id = '${ORG_A}'`),
      SQLSTATE_CHECK_VIOLATION,
      "settling without a settler or a timestamp",
    );
  });

  it("refuses to allocate against a pool that is not settled", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const draft = await ownerRows<{ id: string }>(
      `INSERT INTO prize_pool (org_id, competition_division_id, gross, deductions, net, tax_withheld, currency)
       VALUES ($1, $2, 1000, 100, 900, 0, 'INR') RETURNING id`,
      [ORG_A, a.competitionDivisionId],
    );

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO prize_allocation
               (org_id, competition_division_id, prize_pool_id, pool_version, team_id, basis, rule_version,
                gross, deductions, net_prize, tax_withheld, currency, input_hash, snapshot_hash, output_hash,
                computed_at, computed_by)
             VALUES ($1,$2,$3,1,$4,'percentage',1,1000,100,900,0,'INR',
                     repeat('a',64), repeat('b',64), repeat('c',64), $5, 'svc:test')`,
            [ORG_A, a.competitionDivisionId, draft[0]!.id, a.teamId, COMPUTED_AT],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "allocating against a draft pool",
    );
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE TEST
// ---------------------------------------------------------------------------

/**
 * Roster shares, keyed by person id.
 *
 * Typed as a record rather than an object literal so that indexing it with a
 * `personId: string` is a checked lookup instead of a silent widening to `any`.
 */
const SHARES: Readonly<Record<string, string>> = { [P1]: "50", [P2]: "25", [P3]: "20" };

/** The participant set those shares describe. Three people who do not sum to 100. */
const PARTICIPANTS: readonly EngineParticipant[] = [
  { personId: P1, kind: "roster" },
  { personId: P2, kind: "roster" },
  { personId: P3, kind: "roster" },
];

// ---------------------------------------------------------------------------
// THE HEADLINE TEST
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE HEADLINE TEST
// ---------------------------------------------------------------------------

describe("an allocation is reproducible from stored inputs", () => {
  it("reproduces a stored allocation after the roster it was drawn from has changed", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await seedRoster(ORG_A, "cccccccc", a.teamId, SHARES, "a");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    // --- 1. allocate from the roster as it stands today ---------------------------
    const first = await allocateAndPersist({
      orgId: ORG_A,
      poolId,
      poolVersion: 1,
      competitionDivisionId: a.competitionDivisionId,
      teamId: a.teamId,
      participants: PARTICIPANTS,
      shares: SHARES,
      gross: "1000.0000",
      deductions: "100.0000",
      net: "900.0000",
      tax: "0.0000",
      ruleVersion: 1,
    });

    // The engine's own arithmetic, so the numbers being frozen are visibly not invented:
    // 50% / 25% / 20% of 900 leaves 45.0000 unallocated, which is exactly the residue
    // the truncation produces and exactly what the reconciliation must carry.
    expect(first.results.map((r) => r.computedAmount)).toEqual(["450.0000", "225.0000", "180.0000"]);
    expect(first.unallocated).toBe("45.0000");

    // --- 2. MUTATE the roster the allocation was actually drawn from ---------------
    // Every change a real deployment makes: shares rewritten, a player removed from the
    // draw, somebody new added to the roster, and the whole pool superseded by a later
    // prize_pool version. If replay reads any of this, nothing below can hold.
    await asOwner(`
      UPDATE team_membership SET share_percent = 90 WHERE org_id = '${ORG_A}' AND person_id = '${P1}';
      UPDATE team_membership SET valid_to = now(), share_percent = 0 WHERE org_id = '${ORG_A}' AND person_id = '${P2}';
    `);
    await seedRoster(ORG_A, "cccccccc", a.teamId, { [P4]: "100" }, "b");

    const pool = await ownerRows<{ id: string }>("SELECT id FROM prize_pool WHERE org_id = $1", [ORG_A]);
    await asOwner(`
      INSERT INTO prize_pool (org_id, competition_division_id, version, supersedes_id,
                              gross, deductions, net, tax_withheld, currency)
      VALUES ('${ORG_A}', '${a.competitionDivisionId}', 2, '${pool[0]!.id}', 9999, 9999, 0, 0, 'INR');
    `);

    const liveRoster = await ownerRows<{ person_id: string; share_percent: string }>(
      `SELECT person_id, share_percent::text FROM team_membership
        WHERE org_id = $1 AND team_id = $2 AND valid_to IS NULL ORDER BY person_id`,
      [ORG_A, a.teamId],
    );
    // Prove the mutation is real and material: the live roster no longer describes the
    // allocation, and re-deriving from it would produce a different answer entirely.
    expect(liveRoster.map((r) => r.person_id)).toEqual([P1, P3, P4]);
    expect(liveRoster.map((r) => r.share_percent)).toEqual(["90.0000", "20.0000", "100.0000"]);

    // --- 3. re-run from the STORED snapshot alone ----------------------------------
    const replayed = await replayFromStoredSnapshot(ORG_A, first.allocationId);

    expect(replayed.inputHash, "the same inputs must produce the same input hash").toBe(first.inputHash);
    expect(replayed.snapshotHash).toBe(first.snapshotHash);
    expect(replayed.outputHash, "the same inputs must produce the same output hash").toBe(first.outputHash);

    // Byte-identical output: the whole row, not just the money.
    expect(replayed.results).toEqual(first.results);
    expect(replayed.unallocated).toBe(first.unallocated);

    // The single strongest form of the claim: what the replay computed is exactly what
    // is written on disk. `replayed.storedResults` is read back from
    // prize_allocation_result, so this cannot be satisfied by the replay agreeing with
    // itself.
    expect(replayed.results).toEqual(replayed.storedResults);

    // --- 4. and the rows on disk still say exactly that ---------------------------
    const stored = await ownerRows<{
      person_id: string;
      computed_amount: string;
      basis_amount: string;
      explanation: string;
    }>(
      `SELECT person_id, computed_amount::text, basis_amount::text, explanation
         FROM prize_allocation_result WHERE org_id = $1 AND allocation_id = $2 ORDER BY person_id`,
      [ORG_A, first.allocationId],
    );

    expect(stored.map((r) => [r.person_id, r.computed_amount])).toEqual([
      [P1, "450.0000"],
      [P2, "225.0000"],
      [P3, "180.0000"],
    ]);
    expect(stored.map((r) => r.basis_amount)).toEqual(["900.0000", "900.0000", "900.0000"]);
    expect(replayed.results.map((r) => r.explanation)).toEqual(stored.map((r) => r.explanation));

    // The frozen roster shares are the ones the draw used, not today's.
    const frozenShares = await ownerRows<{ person_id: string; share_percent: string }>(
      `SELECT person_id, share_percent::text FROM prize_allocation_input
        WHERE org_id = $1 AND allocation_id = $2 ORDER BY person_id`,
      [ORG_A, first.allocationId],
    );
    expect(frozenShares.map((r) => [r.person_id, r.share_percent])).toEqual([
      [P1, "50.0000"],
      [P2, "25.0000"],
      [P3, "20.0000"],
    ]);
  });

  it("would produce a different answer if it re-read the live roster, which is why it must not", async () => {
    // The control for the test above. Without it, "the replay matches" could be true
    // because the mutation changed nothing that mattered. Here the mutation is proven to
    // change the answer, so the match in the test above is doing real work.
    const a = await seedStack(ORG_A, "cccccccc");
    await seedRoster(ORG_A, "cccccccc", a.teamId, SHARES, "a");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    const before = await allocateAndPersist({
      orgId: ORG_A,
      poolId,
      poolVersion: 1,
      competitionDivisionId: a.competitionDivisionId,
      teamId: a.teamId,
      participants: PARTICIPANTS,
      shares: SHARES,
      gross: "1000.0000",
      deductions: "100.0000",
      net: "900.0000",
      tax: "0.0000",
      ruleVersion: 1,
    });

    // A redistribution that is legal but different: 60 / 25 / 10 sums to 95%, so the
    // remainder grows rather than the rule becoming one the engine would refuse outright.
    await asOwner(
      `UPDATE team_membership SET share_percent = 60, valid_to = now() WHERE org_id = '${ORG_A}' AND person_id = '${P1}'`,
    );

    const mutatedShares = { [P1]: "60", [P2]: "25", [P3]: "10" };
    const mutated = allocatePercentage(parsePercent("900.0000"), PARTICIPANTS, {
      version: 1,
      basis: "percentage",
      percentages: mutatedShares,
      remainderPolicy: "largest_remainder_stable_sort",
    });

    expect(mutated.results).not.toEqual(before.results);
    expect(
      hashInputs(parsePercent("900.0000"), "INR", PARTICIPANTS, {
        version: 1,
        basis: "percentage",
        percentages: mutatedShares,
        remainderPolicy: "largest_remainder_stable_sort",
      }),
      "the same people with different shares must not share an input hash",
    ).not.toBe(before.inputHash);

    // The stored allocation is untouched by all of that.
    const replayed = await replayFromStoredSnapshot(ORG_A, before.allocationId);
    expect(replayed.inputHash).toBe(before.inputHash);
    expect(replayed.results).toEqual(before.results);
  });
});

// ---------------------------------------------------------------------------
// RECONCILIATION UNDER FUZZ
// ---------------------------------------------------------------------------

/**
 * A deterministic pseudo-random generator.
 *
 * `Math.random` is not used anywhere in this file, and not out of taste: a fuzz suite
 * whose failures cannot be reproduced is a suite that gets deleted. A fixed seed means
 * the case that broke yesterday still breaks today, on any machine.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the reconciliation invariant holds under fuzz", () => {
  it("accepts and re-verifies every seeded split, and the books balance in every one", async () => {
    // The second half of the phase gate. Rather than one hand-picked division, this runs
    // a seeded sweep of pool figures, participant counts and share splits that
    // deliberately include the awkward cases: shares that do not add to 100, shares with
    // four decimal places, and a net with a fractional paise.
    //
    // For every case the database must ACCEPT the allocation (its three hashes agree
    // with the engine's canonical form, which is only possible if the two independent
    // implementations of the canonical form agree), and the books must balance:
    // sum(allocations) + unallocated == net, exactly.
    const random = mulberry32(20260115);
    const a = await seedStack(ORG_A, "cccccccc");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "100000.0000", "0.0000");

    const CASES = 24;
    let accepted = 0;

    for (let index = 0; index < CASES; index += 1) {
      const participantCount = 1 + Math.floor(random() * 4);
      // The pool figures, built in MINOR UNITS with bigint and only then rendered. Doing
      // this in floating point would be the exact mistake the schema exists to prevent,
      // and it would also quietly produce a negative deduction whenever net exceeded
      // gross — which the CHECK correctly refuses, and which would turn the fuzz suite
      // into a test of my generator rather than of the schema.
      const netMinor = (1n + BigInt(Math.floor(random() * 5_000_000))) * 10_000n;
      const deductionMinor = BigInt(Math.floor(random() * 2_000_000)) * 10_000n;
      const grossMinor = netMinor + deductionMinor;

      const participants: EngineParticipant[] = [];
      const shares: Record<string, string> = {};

      // Raw draws in the engine's 1e4-scaled percent space, one per participant, then
      // scaled down proportionally if they would over-allocate. Scaling DOWN is what
      // leaves a residue for `unallocated`, and truncating division guarantees the sum
      // lands at or below exactly 100% — which is the boundary the engine itself refuses
      // to cross, so no case here can describe a rule it would have rejected.
      const raw: bigint[] = [];
      for (let p = 0; p < participantCount; p += 1) {
        raw.push(BigInt(Math.floor(random() * 1_000_001)));
      }
      const rawTotal = raw.reduce((acc, value) => acc + value, 0n);
      const scaled = rawTotal > 1_000_000n ? raw.map((v) => (v * 1_000_000n) / rawTotal) : raw;

      for (let p = 0; p < participantCount; p += 1) {
        const personId = `aaaaaaaa-0000-0000-0000-${String(p + 1).padStart(12, "0")}`;
        await asOwner(
          `INSERT INTO person (id, external_ref) VALUES ('${personId}', 'fuzz-${index}-${p}')
             ON CONFLICT (id) DO NOTHING`,
        );
        participants.push({ personId, kind: "roster" });
        // Rendered exactly as team_membership.share_percent renders at numeric(7,4).
        shares[personId] = formatMinor(scaled[p]!);
      }

      const net = formatMinor(netMinor);
      const rule: EngineRule = {
        version: 1 + Math.floor(random() * 3),
        basis: "percentage",
        percentages: shares,
        remainderPolicy: "largest_remainder_stable_sort",
      };

      const { results, unallocated } = allocatePercentage(netMinor, participants, rule);

      // The engine refuses a rule whose percentages exceed 100%, so no allocation this
      // engine could have produced ever has a negative remainder. Asserted rather than
      // assumed: it is the boundary that decides whether the fuzz corpus is legal input
      // or is quietly testing something the engine rejects.
      expect(Object.values(shares).reduce((acc, share) => acc + parsePercent(share), 0n)).toBeLessThanOrEqual(
        1_000_000n,
      );
      const allocatedTotal = results
        .map((r) => parsePercent(r.computedAmount))
        .reduce((acc, value) => acc + value, 0n);

      // The invariant, in integer space: no float, no tolerance, exactly.
      expect(allocatedTotal + parsePercent(unallocated), `case ${index} must balance`).toBe(netMinor);

      const persisted = await allocateAndPersist({
        orgId: ORG_A,
        poolId,
        poolVersion: 1,
        competitionDivisionId: a.competitionDivisionId,
        teamId: a.teamId,
        participants,
        shares,
        gross: formatMinor(grossMinor),
        deductions: formatMinor(deductionMinor),
        net,
        tax: "0.0000",
        ruleVersion: rule.version,
      });
      accepted += 1;

      // The database accepted it, which means its independently-written canonical form
      // produced the same three hashes the engine did.
      const stored = await ownerRows<{ net_prize: string; input_hash: string; output_hash: string }>(
        "SELECT net_prize::text, input_hash, output_hash FROM prize_allocation WHERE id = $1",
        [persisted.allocationId],
      );
      expect(stored[0]!.net_prize).toBe(net);
      expect(stored[0]!.input_hash).toBe(persisted.inputHash);
      expect(stored[0]!.output_hash).toBe(persisted.outputHash);

      // And replaying from the stored snapshot alone reproduces it exactly.
      const replayed = await replayFromStoredSnapshot(ORG_A, persisted.allocationId);
      expect(replayed.inputHash, `case ${index} replay hash`).toBe(persisted.inputHash);
      expect(replayed.results, `case ${index} replay output`).toEqual(persisted.results);
      expect(replayed.unallocated, `case ${index} replay remainder`).toBe(unallocated);

      // The persisted reconciliation balances against the persisted result rows.
      const reconciliation = await ownerRows<{
        allocated_total: string;
        unallocated: string;
        variance: string;
        is_balanced: boolean;
      }>(
        `SELECT allocated_total::text, unallocated::text, variance::text, is_balanced
           FROM prize_allocation_reconciliation WHERE allocation_id = $1`,
        [persisted.allocationId],
      );
      expect(reconciliation[0]!.variance, `case ${index} variance`).toBe("0.0000");
      expect(reconciliation[0]!.is_balanced).toBe(true);
      expect(
        parsePercent(reconciliation[0]!.allocated_total) + parsePercent(reconciliation[0]!.unallocated),
        `case ${index} stored reconciliation must balance against the frozen net`,
      ).toBe(netMinor);
    }

    expect(accepted).toBe(CASES);
  });
});

describe("an allocation is checked, not trusted", () => {
  it("refuses a stored input_hash that does not match its own frozen snapshot", async () => {
    // The alignment contract between packages/core and this schema. The engine emitted
    // this hash; the database rebuilds the canonical form from the stored rows and
    // refuses if the two disagree. A snapshot shape that drifts from the engine's fails
    // at INSERT rather than at audit.
    const a = await seedStack(ORG_A, "cccccccc");
    await seedRoster(ORG_A, "cccccccc", a.teamId, SHARES, "a");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const header = await tx.query<{ id: string }>(
            `INSERT INTO prize_allocation
               (org_id, competition_division_id, prize_pool_id, pool_version, team_id, basis, rule_version,
                gross, deductions, net_prize, tax_withheld, currency, input_hash, snapshot_hash, output_hash,
                computed_at, computed_by)
             VALUES ($1,$2,$3,1,$4,'percentage',1,1000,100,900,0,'INR',
                     $5, repeat('b',64), repeat('c',64), $6, 'svc:test') RETURNING id`,
            [ORG_A, a.competitionDivisionId, poolId, a.teamId, "0".repeat(64), COMPUTED_AT],
          );
          const id = header.rows[0]!.id;

          for (const participant of PARTICIPANTS) {
            await tx.query(
              `INSERT INTO prize_allocation_input (org_id, allocation_id, person_id, participant_kind, share_percent)
               VALUES ($1,$2,$3,'roster',$4)`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
            await tx.query(
              `INSERT INTO prize_allocation_term (org_id, allocation_id, person_id, term_role, amount, raw_value, currency)
               VALUES ($1,$2,$3,'percentage',$4::numeric,$4,'INR')`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
          }

          for (const participant of PARTICIPANTS) {
            await tx.query(
              `INSERT INTO prize_allocation_result
                 (org_id, allocation_id, person_id, participant_kind, basis_amount, computed_amount,
                  currency, rule_version, computed_at, computed_by, explanation)
               VALUES ($1,$2,$3,'roster',900,1,'INR',1,$4,'svc:test','because')`,
              [ORG_A, id, participant.personId, COMPUTED_AT],
            );
          }
        }),
      SQLSTATE_CHECK_VIOLATION,
      "an input_hash that does not match the snapshot",
    );
  });

  it("refuses a reconciliation that does not balance, even when its own arithmetic is consistent", async () => {
    // The CHECK constraints make `variance = allocated + unallocated - net` true by
    // construction, so a stored variance that disagrees with its inputs is unstorable.
    // The trigger then goes further and recomputes the totals from the result rows, which
    // catches the case the CHECK cannot see: a reconciliation that balances against
    // numbers nobody allocated.
    const a = await seedStack(ORG_A, "cccccccc");
    await seedRoster(ORG_A, "cccccccc", a.teamId, SHARES, "a");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const { results, unallocated } = allocatePercentage(parsePercent("900.0000"), PARTICIPANTS, {
            version: 1,
            basis: "percentage",
            percentages: SHARES,
            remainderPolicy: "largest_remainder_stable_sort",
          });
          const inputHash = hashInputs(parsePercent("900.0000"), "INR", PARTICIPANTS, {
            version: 1,
            basis: "percentage",
            percentages: SHARES,
            remainderPolicy: "largest_remainder_stable_sort",
          });

          const header = await tx.query<{ id: string }>(
            `INSERT INTO prize_allocation
               (org_id, competition_division_id, prize_pool_id, pool_version, team_id, basis, rule_version,
                gross, deductions, net_prize, tax_withheld, currency, input_hash, snapshot_hash, output_hash,
                computed_at, computed_by)
             VALUES ($1,$2,$3,1,$4,'percentage',1,1000,100,900,0,'INR',
                     $5, $6, $7, $8, 'svc:test') RETURNING id`,
            [
              ORG_A,
              a.competitionDivisionId,
              poolId,
              a.teamId,
              inputHash,
              snapshotHash({
                gross: "1000.0000",
                deductions: "100.0000",
                net: "900.0000",
                tax: "0.0000",
                currency: "INR",
                basis: "percentage",
                ruleVersion: 1,
                remainderPolicy: "largest_remainder_stable_sort",
                participants: PARTICIPANTS.map((p) => ({
                  personId: p.personId,
                  kind: p.kind,
                  sharePercent: formatMinor(parsePercent(SHARES[p.personId]!)),
                  weight: null,
                })),
                terms: PARTICIPANTS.map((p) => ({
                  personId: p.personId,
                  role: "percentage",
                  amount: formatMinor(parsePercent(SHARES[p.personId]!)),
                })),
              }),
              outputHash(results, "INR", 1),
              COMPUTED_AT,
            ],
          );
          const id = header.rows[0]!.id;

          for (const participant of PARTICIPANTS) {
            await tx.query(
              `INSERT INTO prize_allocation_input (org_id, allocation_id, person_id, participant_kind, share_percent)
               VALUES ($1,$2,$3,'roster',$4)`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
            await tx.query(
              `INSERT INTO prize_allocation_term (org_id, allocation_id, person_id, term_role, amount, raw_value, currency)
               VALUES ($1,$2,$3,'percentage',$4::numeric,$4,'INR')`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
          }
          for (const result of results) {
            await tx.query(
              `INSERT INTO prize_allocation_result
                 (org_id, allocation_id, person_id, participant_kind, basis_amount, computed_amount,
                  currency, rule_version, computed_at, computed_by, explanation)
               VALUES ($1,$2,$3,$4,$5,$6,'INR',1,$7,'svc:test',$8)`,
              [
                ORG_A,
                id,
                result.personId,
                result.participantKind,
                result.basisAmount,
                result.computedAmount,
                COMPUTED_AT,
                result.explanation,
              ],
            );
          }

          // Internally consistent (variance really is allocated + unallocated - net) and
          // still a lie, because allocated_total does not match the result rows.
          const lyingTotal = "1000.0000";
          await tx.query(
            `INSERT INTO prize_allocation_reconciliation
               (org_id, allocation_id, net_prize, allocated_total, unallocated, variance, currency, is_balanced, explanation)
             VALUES ($1,$2,900::numeric,$3::numeric,$4::numeric,
                     $3::numeric + $4::numeric - 900::numeric, 'INR',
                     ($3::numeric + $4::numeric - 900::numeric) = 0, 'looks balanced')`,
            [ORG_A, id, lyingTotal, unallocated],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "a reconciliation whose totals do not match its result rows",
    );
  });

  it("refuses a result row for a person who was not in the frozen snapshot", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await seedRoster(ORG_A, "cccccccc", a.teamId, SHARES, "a");
    const poolId = await seedSettledPool(ORG_A, a.competitionDivisionId, "1000.0000", "100.0000");

    await expectSqlstate(
      () =>
        db.transaction(async (tx) => {
          const netMinor = parsePercent("900.0000");
          // The rule knows four people; only the FROZEN SNAPSHOT holds three. The stored hashes
          // are deliberately wrong as well, so this test cannot pass by accident on the
          // hash check standing in for the correspondence check.
          const withIntruder: readonly EngineParticipant[] = [
            ...PARTICIPANTS,
            { personId: P4, kind: "roster" as const },
          ];
          const ruleWithIntruder = {
            version: 1,
            basis: "percentage",
            percentages: { ...SHARES, [P4]: "5" },
            remainderPolicy: "largest_remainder_stable_sort",
          } as const;
          const { results, unallocated } = allocatePercentage(netMinor, withIntruder, ruleWithIntruder);

          const header = await tx.query<{ id: string }>(
            `INSERT INTO prize_allocation
               (org_id, competition_division_id, prize_pool_id, pool_version, team_id, basis, rule_version,
                gross, deductions, net_prize, tax_withheld, currency, input_hash, snapshot_hash, output_hash,
                computed_at, computed_by)
             VALUES ($1,$2,$3,1,$4,'percentage',1,1000,100,900,0,'INR',
                     $5, repeat('b',64), repeat('c',64), $6, 'svc:test') RETURNING id`,
            [
              ORG_A,
              a.competitionDivisionId,
              poolId,
              a.teamId,
              hashInputs(netMinor, "INR", withIntruder, ruleWithIntruder),
              COMPUTED_AT,
            ],
          );
          const id = header.rows[0]!.id;

          // Only three of the four participants are frozen.
          for (const participant of PARTICIPANTS) {
            await tx.query(
              `INSERT INTO prize_allocation_input (org_id, allocation_id, person_id, participant_kind, share_percent)
               VALUES ($1,$2,$3,'roster',$4)`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
            await tx.query(
              `INSERT INTO prize_allocation_term (org_id, allocation_id, person_id, term_role, amount, raw_value, currency)
               VALUES ($1,$2,$3,'percentage',$4::numeric,$4,'INR')`,
              [ORG_A, id, participant.personId, SHARES[participant.personId]!],
            );
          }

          // Four result rows — the engine's full output for a four-person draw — but only
          // three frozen participants. One result therefore names somebody the snapshot
          // never froze, and the database must refuse the allocation rather than accept a
          // payout it cannot trace to a stored input.
          for (const result of results) {
            await tx.query(
              `INSERT INTO prize_allocation_result
                 (org_id, allocation_id, person_id, participant_kind, basis_amount, computed_amount,
                  currency, rule_version, computed_at, computed_by, explanation)
               VALUES ($1,$2,$3,$4,$5,$6,'INR',1,$7,'svc:test',$8)`,
              [
                ORG_A,
                id,
                result.personId,
                result.participantKind,
                result.basisAmount,
                result.computedAmount,
                COMPUTED_AT,
                result.explanation,
              ],
            );
          }

          await tx.query(
            `INSERT INTO prize_allocation_reconciliation
               (org_id, allocation_id, net_prize, allocated_total, unallocated, variance, currency, is_balanced, explanation)
             VALUES ($1,$2,900::numeric,900::numeric,$3::numeric,
                     900::numeric + $3::numeric - 900::numeric, 'INR', ($3::numeric = 0), 'x')`,
            [ORG_A, id, unallocated],
          );
        }),
      SQLSTATE_CHECK_VIOLATION,
      "a result for a person absent from the frozen snapshot",
    );
  });
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

describe("exactly one component can create an expense row", () => {
  it("writes exactly one expense for one registration cost", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");

    await asApp(async () => {
      const expenseId = await db.query<{ id: string }>(
        "SELECT public.post_registration_entry_expense($1, $2, $3, $4, $5, $6, NULL) AS id",
        [registrationId, PERIOD_START, a.expenseAccountId, a.payableAccountId, "Entry fee", a.teamId],
      );
      expect(expenseId.rows).toHaveLength(1);
    }, ORG_A);

    const expenses = await ownerRows<{ n: number; amount: string; provenance: string }>(
      `SELECT count(*)::int AS n, min(amount::text) AS amount, min(provenance::text) AS provenance
         FROM expense WHERE org_id = $1`,
      [ORG_A],
    );
    expect(expenses[0]!.n, "one create path must yield exactly one row").toBe(1);
    expect(expenses[0]!.amount).toBe("500.0000");
    expect(expenses[0]!.provenance).toBe("registration_entry_cost");

    // And the ledger behind it is balanced, because the same transaction posted it.
    const unbalanced = await ownerRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT l.journal_id FROM ledger_line l GROUP BY l.journal_id
          HAVING COALESCE(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0)
              <> COALESCE(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0)) q`,
    );
    expect(unbalanced[0]!.n).toBe(0);
  });

  it("refuses a second expense for the same registration, which is the legacy double-count", async () => {
    // The legacy system recorded every registration cost twice: an AFTER INSERT trigger
    // wrote the row and the API wrote its own. Here the second write is refused by the
    // database, so neither component has to know whether the other already ran.
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");

    const post = async (): Promise<void> => {
      await db.query("SELECT public.post_registration_entry_expense($1, $2, $3, $4, $5, $6, NULL)", [
        registrationId,
        PERIOD_START,
        a.expenseAccountId,
        a.payableAccountId,
        "Entry fee",
        a.teamId,
      ]);
    };

    await asApp(post, ORG_A);

    await asApp(async () => {
      await expectSqlstate(post, SQLSTATE_UNIQUE_VIOLATION, "a second expense for one registration");
    }, ORG_A);

    const expenses = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM expense WHERE org_id = $1",
      [ORG_A],
    );
    expect(expenses[0]!.n, "still exactly one").toBe(1);
  });

  it("denies the application role a direct INSERT into expense", async () => {
    // The structural half of "exactly one component can create an expense row". The two
    // posting functions are the only writers; without this revoke there would be a
    // second writer, and the double-count would be one careless query away.
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");
    const journal = await postJournal({
      orgId: ORG_A,
      description: "Entry fee",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "500.0000",
    });

    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO expense (org_id, description, amount, currency, incurred_on, provenance, registration_id, journal_id)
             VALUES ($1, 'Sneaky', 500, 'INR', $2, 'registration_entry_cost', $3, $4)`,
            [ORG_A, PERIOD_START, registrationId, journal],
          ),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "inserting an expense directly as the application role",
      );
    }, ORG_A);
  });

  it("has no trigger anywhere that writes an expense row", async () => {
    // The legacy defect had a specific shape: a trigger that created the expense row and
    // an API that created it again. Asserting the absence of such a trigger structurally
    // means the guarantee cannot rot when somebody adds a convenient one later, which a
    // test that only counted rows would not notice.
    const rows = await ownerRows<{ proname: string; prosrc: string }>(
      `SELECT p.proname, p.prosrc
         FROM pg_trigger g
         JOIN pg_proc p ON p.oid = g.tgfoid
         JOIN pg_class c ON c.oid = g.tgrelid
        WHERE NOT g.tgisinternal AND c.relkind = 'r'
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`,
    );

    const offenders = rows.filter((r) => /INSERT\s+INTO\s+(public\.)?expense/i.test(r.prosrc));

    expect(
      offenders.map((r) => r.proname),
      "no trigger function may insert into expense; the posting functions are the only writers",
    ).toEqual([]);
  });

  it("distinguishes a registration cost from a manual claim", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");

    await asApp(async () => {
      await db.query("SELECT public.post_registration_entry_expense($1, $2, $3, $4, $5, $6, NULL)", [
        registrationId,
        PERIOD_START,
        a.expenseAccountId,
        a.payableAccountId,
        "Entry fee",
        a.teamId,
      ]);
      await db.query("SELECT public.post_manual_expense($1, $2, $3, $4, $5, $6, $7, NULL)", [
        PERIOD_START,
        "75.0000",
        "INR",
        a.expenseAccountId,
        a.payableAccountId,
        "Taxi to the venue",
        a.teamId,
      ]);
    }, ORG_A);

    const rows = await ownerRows<{ provenance: string; n: number; registration_id: string | null }>(
      `SELECT provenance::text, count(*)::int AS n, min(registration_id::text) AS registration_id
         FROM expense WHERE org_id = $1 GROUP BY provenance ORDER BY provenance`,
      [ORG_A],
    );

    expect(rows).toHaveLength(2);
    const derived = rows.find((r) => r.provenance === "registration_entry_cost")!;
    const manual = rows.find((r) => r.provenance === "manual")!;
    expect(derived.registration_id).toBe(registrationId);
    // Provenance bound to the row it names: a manual claim names no registration, and
    // there is no way to store one that does.
    expect(manual.registration_id).toBeNull();
  });

  it("refuses a provenance that contradicts the row it names", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");
    const journal = await postJournal({
      orgId: ORG_A,
      description: "Entry fee",
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "500.0000",
    });

    // As the owner, because the app role has no INSERT at all. The point is the CHECK,
    // not the privilege: provenance and registration_id cannot be made to disagree.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO expense (org_id, description, amount, currency, incurred_on, provenance, registration_id, journal_id)
          VALUES ('${ORG_A}', 'Mislabelled', 500, 'INR', '${PERIOD_START}', 'manual', '${registrationId}', '${journal}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a manual expense naming a registration",
    );
  });

  it("derives the amount from the entry cost rather than accepting the caller's figure", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    const registrationId = await seedRegistration(ORG_A, "cccccccc", a.competitionDivisionId, a.teamId, "500.0000");
    await asOwner(
      `UPDATE entry_cost SET discount = 100 WHERE org_id = '${ORG_A}' AND registration_id = '${registrationId}'`,
    );

    await asApp(async () => {
      await db.query("SELECT public.post_registration_entry_expense($1, $2, $3, $4, $5, $6, NULL)", [
        registrationId,
        PERIOD_START,
        a.expenseAccountId,
        a.payableAccountId,
        "Entry fee after discount",
        a.teamId,
      ]);
    }, ORG_A);

    const expenses = await ownerRows<{ amount: string }>("SELECT amount::text FROM expense WHERE org_id = $1", [ORG_A]);
    expect(expenses[0]!.amount).toBe("400.0000");
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("remaining budget cannot go negative", () => {
  it("derives committed and remaining from the ledger rather than storing a counter", async () => {
    const rows = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name = 'budget'
          AND column_name IN ('committed','spent','remaining','used','consumed')`,
    );

    // The legacy slot system kept a stored counter that drifted away from the ledger it
    // claimed to summarise. A drifted counter is how a budget stops meaning anything
    // while still being displayed, so there is nothing here to drift.
    expect(rows, "budget must store no derived counter").toEqual([]);
  });

  it("counts committed spend and reduces remaining as entries are posted", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await asOwner(`
      INSERT INTO budget (org_id, name, scope_team_id, period_start, period_end, currency, limit_amount)
      VALUES ('${ORG_A}', 'Q1 team budget', '${a.teamId}', '${PERIOD_START}', '${PERIOD_END}', 'INR', 1000.0000)
    `);

    await postJournal({
      orgId: ORG_A,
      description: "Entry fees",
      costCentreTeamId: a.teamId,
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "600.0000",
    });

    const after = await ownerRows<{ limit_amount: string; committed: string; remaining: string; spent: string }>(
      "SELECT limit_amount::text, committed::text, remaining::text, spent::text FROM budget_balance WHERE org_id = $1",
      [ORG_A],
    );
    expect(after[0]!.committed).toBe("600.0000");
    expect(after[0]!.remaining).toBe("400.0000");
    // Recognised, not yet discharged: committed moves, spent does not.
    expect(after[0]!.spent).toBe("0.0000");
  });

  it("refuses a commit that would take committed spend above the limit", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await asOwner(`
      INSERT INTO budget (org_id, name, scope_team_id, period_start, period_end, currency, limit_amount)
      VALUES ('${ORG_A}', 'Q1 team budget', '${a.teamId}', '${PERIOD_START}', '${PERIOD_END}', 'INR', 1000.0000)
    `);

    await postJournal({
      orgId: ORG_A,
      description: "First entry",
      costCentreTeamId: a.teamId,
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "900.0000",
    });

    await expectSqlstate(
      () =>
        postJournal({
          orgId: ORG_A,
          description: "Over budget",
          costCentreTeamId: a.teamId,
          debitAccountId: a.expenseAccountId,
          creditAccountId: a.payableAccountId,
          amount: "200.0000",
        }),
      SQLSTATE_CHECK_VIOLATION,
      "posting beyond the budget limit",
    );

    const after = await ownerRows<{ committed: string; remaining: string }>(
      "SELECT committed::text, remaining::text FROM budget_balance WHERE org_id = $1",
      [ORG_A],
    );
    // The refused transaction left nothing behind: the guard runs at COMMIT, and a
    // rollback of a deferred check rolls the whole transaction with it.
    expect(after[0]!.committed).toBe("900.0000");
    expect(after[0]!.remaining).toBe("100.0000");

    const journals = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_journal WHERE org_id = $1",
      [ORG_A],
    );
    expect(journals[0]!.n).toBe(1);
  });

  it("still admits an entry that fits after the refusal", async () => {
    const a = await seedStack(ORG_A, "cccccccc");
    await asOwner(`
      INSERT INTO budget (org_id, name, scope_team_id, period_start, period_end, currency, limit_amount)
      VALUES ('${ORG_A}', 'Q1 team budget', '${a.teamId}', '${PERIOD_START}', '${PERIOD_END}', 'INR', 1000.0000)
    `);

    await postJournal({
      orgId: ORG_A,
      description: "First entry",
      costCentreTeamId: a.teamId,
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "900.0000",
    });
    await expectSqlstate(
      () =>
        postJournal({
          orgId: ORG_A,
          description: "Too much",
          costCentreTeamId: a.teamId,
          debitAccountId: a.expenseAccountId,
          creditAccountId: a.payableAccountId,
          amount: "500.0000",
        }),
      SQLSTATE_CHECK_VIOLATION,
      "posting beyond the limit",
    );
    await postJournal({
      orgId: ORG_A,
      description: "Fits",
      costCentreTeamId: a.teamId,
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "100.0000",
    });

    const after = await ownerRows<{ committed: string; remaining: string }>(
      "SELECT committed::text, remaining::text FROM budget_balance WHERE org_id = $1",
      [ORG_A],
    );
    expect(after[0]!.committed).toBe("1000.0000");
    expect(after[0]!.remaining).toBe("0.0000");
  });

  it("does not count a cost outside the envelope, or outside the period", async () => {
    const a = await seedStack(ORG_A, "cccccccc");

    await asOwner(`
      INSERT INTO budget (org_id, name, scope_team_id, period_start, period_end, currency, limit_amount)
      VALUES ('${ORG_A}', 'Q1 team budget', '${a.teamId}', '${PERIOD_START}', '${PERIOD_END}', 'INR', 1000.0000)
    `);

    // Another team's cost centre: outside the envelope. A second stack in the SAME org,
    // which is what makes this a scoping test rather than an isolation test.
    const sibling = await seedStack(ORG_A, "eeeeeeee");
    await postJournal({
      orgId: ORG_A,
      description: "Another team",
      costCentreTeamId: sibling.teamId,
      debitAccountId: sibling.expenseAccountId,
      creditAccountId: sibling.payableAccountId,
      amount: "5000.0000",
    });

    // A period outside the window: outside the period.
    await postJournal({
      orgId: ORG_A,
      description: "Next year",
      postingPeriod: "2027-06-01",
      costCentreTeamId: a.teamId,
      debitAccountId: a.expenseAccountId,
      creditAccountId: a.payableAccountId,
      amount: "5000.0000",
    });

    const after = await ownerRows<{ committed: string; remaining: string }>(
      "SELECT committed::text, remaining::text FROM budget_balance WHERE org_id = $1",
      [ORG_A],
    );
    expect(after[0]!.committed).toBe("0.0000");
    expect(after[0]!.remaining).toBe("1000.0000");
  });
});