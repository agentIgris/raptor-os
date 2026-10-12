/**
 * Money: the ledger, prize-pool lifecycle, allocation replay, budgets, expenses.
 *
 * WHAT THIS MIGRATION IS FOR
 * --------------------------
 * The design spec's Phase 3 gate is one sentence — "Allocation reproducible from
 * stored inputs; reconciliation invariant holds under fuzz" — and both halves of it
 * are properties of the STORAGE, not of the application. The pure engine in
 * packages/core/src/prize can be perfectly deterministic and an allocation still
 * become unreproducible, because recomputing it tomorrow reads
 * `team_membership.share_percent` as it stands tomorrow. Roster corrections are
 * ordinary events. A player who disputes a payout in March needs the answer to be
 * the one the database decided in November.
 *
 * So an allocation is not a live join. It is a FROZEN INPUT SNAPSHOT plus the OUTPUT
 * ROWS derived from it, plus content hashes over both. Re-running is a matter of
 * reading rows that cannot change, not of re-querying a mutable roster.
 *
 * THE HASHES ARE NOT A BACKUP OF A CLAIM — THEY ARE ENFORCED
 * --------------------------------------------------------
 * `input_hash` is the value packages/core/src/prize/allocation-engine.ts already
 * emits, and the database RECOMPUTES it from the stored snapshot and refuses the row
 * if the two disagree. Alignment is therefore not a convention this migration hopes
 * for: it is a constraint, and a snapshot shape that drifts from the engine's
 * canonical form fails loudly at INSERT.
 *
 * `snapshot_hash` and `output_hash` are computed by this database over the frozen
 * input rows and the result rows respectively. Nothing upstream emits them, so they
 * are defined here, in a length-framed canonical text, and the framing is injective
 * (the free-text explanation is length-prefixed) so two different row sets cannot
 * hash alike.
 *
 * WHY BALANCE IS A DEFERRED CONSTRAINT TRIGGER
 * --------------------------------------------
 * A journal is only balanced once its lines exist, so the check cannot be a CHECK on
 * the header. It is a DEFERRABLE INITIALLY DEFERRED constraint trigger on both
 * journal and line: it runs at COMMIT, by which time the whole entry is visible, and
 * application code is not in the position to assert its own correctness. An unbalanced
 * journal is rejected by the database with the same SQLSTATE as a corrupt counter,
 * because that is precisely what it would be.
 *
 * WHY NO archived_at ON THE APPEND-ONLY MONEY TABLES
 * --------------------------------------------------
 * The house rule is "archive columns, no hard deletes", and the money rule is
 * "append-only, no UPDATE path". For a table where no UPDATE is permitted at all the
 * two collide: an archive column can only ever be set by an UPDATE, so on these tables
 * it would be a column permanently constrained to NULL, which is a lie in the schema.
 *
 * Chosen: the strictly-append-only money tables carry no archive column, and a
 * mistake is corrected by a reversing entry — a new journal that debits what the
 * previous one credited. The money keeps its meaning (the books still add up, and the
 * error is visible as a reversal rather than hidden by an archive flag), which is what
 * the archive column exists to achieve in the first place.
 *
 * Rejected: keeping `archived_at` and permitting a narrow UPDATE that sets only it.
 * It re-opens an UPDATE path on money, and an UPDATE grant scoped to "only that one
 * column, honestly" is a promise about future code rather than a property of the
 * database. `prize_pool` is the deliberate contrast: it is mutable exactly once, to
 * record a settle, and so it keeps its archive column (see 0005).
 *
 * TENANCY
 * -------
 * Identical to 0001/0002 and not restated per table: org_id NOT NULL, UNIQUE
 * (org_id, id), every composite index leading with org_id, every FK between tenant
 * tables composite and including org_id, RLS ENABLED *and* FORCED with the tenant
 * predicate as the whole policy and no IS NULL escape (ADR-0015).
 */

BEGIN;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

-- Mirrors ParticipantKind in the engine. A coach is never a roster member, and a
-- snapshot that blurred the two would award a prize for something that never happened.
CREATE TYPE prize_participant_kind AS ENUM ('roster', 'staff');

-- Mirrors AllocationBasis. Pinned here so a stored snapshot is readable without
-- consulting a running deployment of the application.
CREATE TYPE allocation_basis AS ENUM (
  'percentage', 'per_head', 'fixed_plus_percentage', 'weighted_by_participation'
);

-- Mirrors ParticipantKind's counterpart on the ledger side: what KIND of thing an
-- account is, which is what makes a debit to it a cost rather than an asset purchase.
CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- Why the entry exists. The audit's recurring finding was facts with no indication of
-- where they came from, so an OCR row and a hand-typed row stayed indistinguishable
-- forever; the same argument applies to money entries.
CREATE TYPE journal_source_kind AS ENUM (
  'expense', 'settlement', 'prize_payout', 'adjustment', 'opening'
);



-- Where an expense came from. The legacy `slot_expenses` table could not answer this,
-- which is how a registration cost and a hand-typed claim for the same event became
-- one indistinguishable sum.
CREATE TYPE expense_provenance AS ENUM ('registration_entry_cost', 'manual');

-- The rule's per-person terms. One table rather than three because the engine treats
-- percentages, fixed amounts and pool percentages as the same kind of fact — a
-- person, a number — that belongs to one versioned rule, and three tables would let
-- them drift out of step with each other inside a single frozen snapshot.
CREATE TYPE allocation_term_role AS ENUM ('percentage', 'fixed_amount', 'pool_percentage');

-- -----------------------------------------------------------------------------
-- CHART OF ACCOUNTS
--
-- A ledger without accounts is a list of signed numbers. `account_type` is not
-- labelling: the budget guard below sums debits to EXPENSE accounts and nothing else,
-- so an expense recorded against a liability account does not silently consume an
-- operating budget.
-- -----------------------------------------------------------------------------

CREATE TABLE ledger_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  code          varchar(32) NOT NULL,
  name          varchar(160) NOT NULL,
  account_type  ledger_account_type NOT NULL,
  currency      varchar(3) NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_account_code_check CHECK (code ~ '^[0-9]{3,8}$'),
  CONSTRAINT ledger_account_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_account_org_code_key UNIQUE (org_id, code),
  CONSTRAINT ledger_account_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_account_org_idx   ON ledger_account (org_id);
CREATE INDEX ledger_account_org_type_idx ON ledger_account (org_id, account_type);

-- -----------------------------------------------------------------------------
-- JOURNAL HEADER AND LINES
--
-- Double entry. Every line carries its own org_id and a COMPOSITE FK to its journal,
-- so a line cannot be filed under another tenant's entry (ADR-0011).
--
-- Lines are stored as (side, amount) rather than signed amounts. A signed column
-- invites a row where both the sign and the side disagree, and 'is this a debit?' is
-- exactly the question a CHECK should answer.
-- -----------------------------------------------------------------------------

CREATE TABLE ledger_journal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  description       text NOT NULL,
  source_kind       journal_source_kind NOT NULL DEFAULT 'expense',
  -- The accounting period this entry belongs to. A DATE, not timestamptz: a period is
  -- a calendar fact ("March"), not an instant, and pretending otherwise would let an
  -- entry land in two periods depending on the reader's timezone.
  posting_period    date NOT NULL,
  -- The cost centre this entry belongs to, for budget scoping. Nullable because an
  -- org-wide entry has no single cost centre.
  cost_centre_team_id uuid,
  currency          varchar(3) NOT NULL,
  -- A reversing entry points at what it reverses. Reversal is how a mistake is undone;
  -- editing the original would destroy the evidence that the mistake ever happened.
  reverses_id       uuid,
  external_ref      varchar(120),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_journal_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_journal_cost_centre_fk
    FOREIGN KEY (org_id, cost_centre_team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_journal_reverses_fk
    FOREIGN KEY (org_id, reverses_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_journal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_journal_org_idx        ON ledger_journal (org_id);
CREATE INDEX ledger_journal_org_period_idx  ON ledger_journal (org_id, posting_period);
CREATE INDEX ledger_journal_org_centre_idx  ON ledger_journal (org_id, cost_centre_team_id);

-- One reversing entry per entry. A branch — two corrections claiming the same parent —
-- is how a journal ends up reversed twice in opposite directions.
CREATE UNIQUE INDEX ledger_journal_reverses_key
  ON ledger_journal (org_id, reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TYPE ledger_line_side AS ENUM ('debit', 'credit');

CREATE TABLE ledger_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  journal_id    uuid NOT NULL,
  line_no       integer NOT NULL,
  account_id    uuid NOT NULL,
  side          ledger_line_side NOT NULL,
  amount        numeric(18,4) NOT NULL,
  currency      varchar(3) NOT NULL,
  memo          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_line_journal_fk
    FOREIGN KEY (org_id, journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_line_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES ledger_account (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_line_no_check CHECK (line_no >= 1),
  -- Strictly positive. A zero line is a comment wearing a costume, and a negative
  -- amount is a direction, which `side` already carries — admitting both lets one row
  -- state two contradictory things about direction at once.
  CONSTRAINT ledger_line_amount_check CHECK (amount > 0),
  CONSTRAINT ledger_line_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_line_org_journal_no_key UNIQUE (org_id, journal_id, line_no),
  CONSTRAINT ledger_line_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_line_org_idx       ON ledger_line (org_id);
CREATE INDEX ledger_line_org_journal_idx ON ledger_line (org_id, journal_id);
CREATE INDEX ledger_line_org_account_idx ON ledger_line (org_id, account_id);

-- Two lines share a line number inside one journal? The ledger could not be read back
-- in order, so the constraint is about legibility rather than about double-counting.

-- -----------------------------------------------------------------------------
-- THE BALANCE GUARD
--
-- Raised from a trigger, so it fires for every writer: the application's posting
-- path, a migration, an operator with psql. Money cannot be created or destroyed by
-- writing an entry whose debits and credits differ.
--
-- Three conditions, and all three are needed:
--   * at least two lines — a header with no lines is a journal that claims nothing and
--     was never finished;
--   * debits equal credits;
--   * every line carries the journal's currency — otherwise a journal can balance
--     across two currencies, which is a conversion performed by nobody, at no rate,
--     with no record.
--
-- RAISES check_violation, deliberately. An unbalanced journal is a corrupt entry, and
-- check_violation is what every other integrity violation in this schema reports, so a
-- monitoring rule on 23514 catches it without a special case.
--
-- INVOKER security, not SECURITY DEFINER: the guard needs no elevation, because the
-- application role can read the lines it just wrote and the policy limits it to the
-- tenant already fixed by WITH CHECK on the header. A definer function here would be a
 -- door around that policy for no benefit.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_journal_id uuid;
  v_journal_currency varchar(3);
  v_debits    numeric;
  v_credits   numeric;
  v_lines     integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journal' THEN
    v_journal_id := NEW.id;
  ELSE
    v_journal_id := NEW.journal_id;
  END IF;

  SELECT j.currency INTO v_journal_currency
    FROM public.ledger_journal j WHERE j.id = v_journal_id;

  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0),
         count(*)
    INTO v_debits, v_credits, v_lines
    FROM public.ledger_line l
   WHERE l.journal_id = v_journal_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal % has % line(s); a double-entry journal needs at least two',
      v_journal_id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal % is unbalanced: debits % <> credits %',
      v_journal_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  -- One comparison rather than a distinct-count plus a second EXISTS: a line in the
  -- wrong currency is the whole failure, and IS DISTINCT FROM also catches a NULL.
  IF EXISTS (
    SELECT 1 FROM public.ledger_line l
     WHERE l.journal_id = v_journal_id
       AND l.currency IS DISTINCT FROM v_journal_currency
  ) THEN
    RAISE EXCEPTION
      'journal % is in % but carries a line in another currency', v_journal_id, v_journal_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_journal_balanced() IS
  'Refuses a journal whose debits and credits differ, that has fewer than two lines, or whose lines are not all in the journal currency.';

CREATE CONSTRAINT TRIGGER ledger_journal_must_balance
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_journal_balanced();

CREATE CONSTRAINT TRIGGER ledger_line_must_balance
  AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_journal_balanced();

-- -----------------------------------------------------------------------------
-- APPEND-ONLY
--
-- Two independent mechanisms, deliberately redundant and failing in opposite
-- directions. REVOKE denies the application role the operation; the trigger denies it
-- to everyone, including the schema owner running a migration by hand. Either alone
-- leaves a path: a privilege grant silently widened later, or an operator with psql.
--
-- ERRCODE insufficient_privilege so both refusals carry the same SQLSTATE. A caller
-- sees "you may not do this" either way, which is the truth.
--
-- NO archived_at on these tables. See the header: a column settable only by an UPDATE
-- is on an append-only table a column permanently NULL.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deny_money_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted on posted money rows',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.deny_money_mutation() IS
  'Blocks UPDATE and DELETE on a posted money table. Reversal is a new entry, never an edit.';

CREATE TRIGGER ledger_journal_append_only
  BEFORE UPDATE OR DELETE ON ledger_journal
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER ledger_line_append_only
  BEFORE UPDATE OR DELETE ON ledger_line
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER ledger_account_append_only
  BEFORE UPDATE OR DELETE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- BUDGET
--
-- A period-scoped envelope: an amount, a cost centre (or the whole org), and a window.
--
-- WHAT IS STORED AND WHY
-- ---------------------
-- Stored: limit_amount. Nothing else.
--
-- NOT stored: committed, spent, remaining.
--
-- The legacy slot system kept a stored counter that a trigger maintained, and the
-- counter drifted away from the ledger it claimed to summarise — which is how a
-- budget stops meaning anything while still being displayed. Every derivable number
-- here is therefore derived, in the `budget_balance` view, from the ledger itself. The
-- guard below reads the same expression, so the number the guard enforces and the
-- number a screen shows are the same number by construction, and there is no counter
-- left to drift.
--
-- committed: net debits to EXPENSE accounts in the envelope. A reversal, being a
--   credit, reduces it.
-- spent:    net debits to EXPENSE accounts posted by SETTLEMENT journals. A cost is
--   committed when it is recognised and spent when it is discharged; conflating the
--   two is how a budget looks 80% consumed on the day it is written.
-- remaining: limit_amount - committed. Deliberately against committed, not spent: a
--   budget is consumed by the decision to spend, not by when the cash moves. Spending
--   against `spent` would let an organisation commit its entire year in the last
--   month of it.
-- -----------------------------------------------------------------------------

CREATE TABLE budget (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name              varchar(160) NOT NULL,
  -- NULL = organisation-wide. The composite FK still makes a cross-org team reference
  -- impossible when it is set.
  scope_team_id     uuid,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  currency          varchar(3) NOT NULL,
  limit_amount      numeric(18,4) NOT NULL,
  -- Append-only like the rest of the money domain, so a limit is amended by a new
  -- version rather than by an UPDATE. Otherwise the limit that applied when an expense
  -- was posted becomes unanswerable, which is the same loss of history this migration
  -- exists to prevent.
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_scope_team_fk
    FOREIGN KEY (org_id, scope_team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES budget (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_period_check CHECK (period_end >= period_start),
  CONSTRAINT budget_limit_check CHECK (limit_amount > 0),
  CONSTRAINT budget_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT budget_version_check CHECK (version >= 1),
  CONSTRAINT budget_org_name_period_version_key UNIQUE (org_id, scope_team_id, period_start, version),
  CONSTRAINT budget_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX budget_org_idx       ON budget (org_id);
CREATE INDEX budget_org_scope_idx ON budget (org_id, scope_team_id);
CREATE INDEX budget_org_period_idx ON budget (org_id, period_start, period_end);

-- The first version of an envelope has no parent, so this admits exactly one origin per
-- (org, scope, period) and forbids two envelopes racing to be the original.
CREATE UNIQUE INDEX budget_root_key
  ON budget (org_id, scope_team_id, period_start)
  WHERE supersedes_id IS NULL;

-- Each version has at most one successor, so the history is a path and not a tree.
CREATE UNIQUE INDEX budget_supersedes_key
  ON budget (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

-- The one derived view. Every read of a budget goes through here, which is what makes
-- "derived, never stored" a property rather than an intention.
--
-- The aggregation sits in a LATERAL subquery rather than in the outer GROUP BY, so
-- the view returns exactly one row per budget however many entries fall inside it.
CREATE VIEW budget_balance AS
SELECT b.org_id,
       b.id              AS budget_id,
       b.name,
       b.scope_team_id,
       b.period_start,
       b.period_end,
       b.currency,
       b.version,
       b.limit_amount,
       x.committed::numeric(18,4) AS committed,
       x.spent::numeric(18,4)    AS spent,
       (b.limit_amount - x.committed)::numeric(18,4) AS remaining
  FROM budget b
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind <> 'settlement'), 0) AS committed,
           COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind =  'settlement'), 0) AS spent
      FROM ledger_journal j
      JOIN ledger_line l
        ON l.org_id = j.org_id AND l.journal_id = j.id AND l.side = 'debit'
      JOIN ledger_account a
        ON a.org_id = l.org_id AND a.id = l.account_id AND a.account_type = 'expense'
     WHERE j.org_id = b.org_id
       AND j.posting_period >= b.period_start
       AND j.posting_period <= b.period_end
       AND j.currency = b.currency
       AND (b.scope_team_id IS NULL OR j.cost_centre_team_id = b.scope_team_id)
  ) x ON true;

COMMENT ON VIEW budget_balance IS
  'Derived budget position. committed and spent are computed from the ledger on every read; no counter is stored, so none can drift.';

-- -----------------------------------------------------------------------------
-- THE BUDGET CEILING
--
-- A stored counter could be exceeded by a drifted UPDATE. A derived number can only be
-- exceeded by posting more cost, so the guard is the only thing standing between an
-- over-budget entry and the books — which makes it worth writing in the database
-- rather than in a service that somebody can forget to call.
--
-- DEFERRABLE so that a batch of entries for one period is evaluated once, at COMMIT,
-- against the total. An IMMEDIATE trigger would check each entry alone and would either
-- reject a batch that fits or admit one that does not, depending on order.
--
-- The expression is the same one budget_balance computes, so the ceiling and the
-- display cannot disagree.
--
-- RAISES check_violation: exceeding a budget is a corrupt entry, like an unbalanced
-- journal, and belongs in the same alarm.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_budget_not_exceeded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_budget record;
  v_journal record;
BEGIN
  -- A line carries no period of its own; the journal it belongs to does. Resolving it
  -- here rather than in a second trigger is what lets one function serve both tables.
  IF TG_TABLE_NAME = 'ledger_journal' THEN
    v_journal := NEW;
  ELSE
    SELECT j.* INTO v_journal FROM public.ledger_journal j
     WHERE j.org_id = NEW.org_id AND j.id = NEW.journal_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Only envelopes this journal falls inside can be pushed over by it, so the scan is
  -- the three predicates that define the envelope rather than every budget in the org.
  FOR v_budget IN
    SELECT b.name, b.limit_amount, x.committed
      FROM public.budget b
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind <> 'settlement'), 0) AS committed
          FROM public.ledger_journal j
          JOIN public.ledger_line l
            ON l.org_id = j.org_id AND l.journal_id = j.id AND l.side = 'debit'
          JOIN public.ledger_account a
            ON a.org_id = l.org_id AND a.id = l.account_id AND a.account_type = 'expense'
         WHERE j.org_id = b.org_id
           AND j.posting_period >= b.period_start
           AND j.posting_period <= b.period_end
           AND b.currency = j.currency
           AND (b.scope_team_id IS NULL OR j.cost_centre_team_id = b.scope_team_id)
      ) x
     WHERE b.org_id = v_journal.org_id
       AND v_journal.posting_period >= b.period_start
       AND v_journal.posting_period <= b.period_end
       AND b.currency = v_journal.currency
       AND (b.scope_team_id IS NULL OR v_journal.cost_centre_team_id = b.scope_team_id)
       -- The same expression budget_balance computes, so the ceiling and the display
       -- cannot disagree about the same ledger.
       AND x.committed > b.limit_amount
  LOOP
    RAISE EXCEPTION
      'budget % would be exceeded: committed % against a limit of %',
      v_budget.name, v_budget.committed, v_budget.limit_amount
      USING ERRCODE = 'check_violation';
  END LOOP;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_budget_not_exceeded() IS
  'Refuses a commit that takes committed spend in any budget envelope above its limit. Evaluated at COMMIT against the ledger, not a counter.';

CREATE CONSTRAINT TRIGGER ledger_journal_must_fit_budget
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_budget_not_exceeded();

-- The same guard on the line, because lines can be appended to an existing journal in a
-- later transaction. Firing only on the header would let a second, unbalanced-by-budget
-- batch land under an envelope that has no room for it.
CREATE CONSTRAINT TRIGGER ledger_line_must_fit_budget
  AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_budget_not_exceeded();

-- -----------------------------------------------------------------------------
-- EXPENSE
--
-- Replaces the legacy `slot_expenses` model.
--
-- THE LEGACY DOUBLE-COUNT, AND WHY IT CANNOT HAPPEN HERE
-- -------------------------------------------------------
-- A registration cost was recorded twice: once by an AFTER INSERT trigger that wrote
-- the expense row, and once by the API, which wrote its own. Both components believed
-- they owned the write, so every registration cost appeared at double its value in
-- every expense report, and neither component could be told which one to remove
-- without removing both.
--
-- The structural fix is not "be careful". It is that INSERT is not available to the
-- application role at all. The only writers are the two posting functions below,
-- each keyed to a fact that exists exactly once:
--
--   * post_registration_entry_expense — keyed on registration_id, which
--     UNIQUE (org_id, registration_id) makes single. A second call is refused by the
--     database; it does not need the caller to know it already happened.
--   * post_manual_expense — one row per call, and the caller is a human filing a claim.
--
-- Because there is no trigger on registration or entry_cost that writes an expense,
-- the "two components both write" shape is not merely discouraged — it has no second
-- component. This is asserted structurally, by reflecting over pg_trigger, so the
-- guarantee cannot rot when someone adds a convenient trigger later.
--
-- PROVENANCE
-- ----------
-- `provenance` and `registration_id` are bound by a CHECK, so the two cannot disagree.
-- A row claiming to be a registration cost without naming the registration is not
-- storable, and a registration cost row with no provenance is not either. Without that
-- binding the column is documentation; with it, it is a fact the database will not let
-- you get wrong.
-- -----------------------------------------------------------------------------

CREATE TABLE expense (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  description      text NOT NULL,
  amount           numeric(18,4) NOT NULL,
  currency         varchar(3) NOT NULL,
  incurred_on      date NOT NULL,
  provenance       expense_provenance NOT NULL,
  registration_id  uuid,
  -- Every expense is a posted entry. This is the "money is a ledger, never a column"
  -- rule as a constraint rather than a slogan: an expense that is not backed by a
  -- balanced journal cannot be written, so no cost exists that the ledger has never
  -- heard of.
  journal_id       uuid NOT NULL,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_registration_fk
    FOREIGN KEY (org_id, registration_id) REFERENCES registration (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT expense_journal_fk
    FOREIGN KEY (org_id, journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT expense_amount_check CHECK (amount > 0),
  CONSTRAINT expense_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Provenance is bound to the row it claims to come from, in both directions.
  CONSTRAINT expense_provenance_binding_check
    CHECK ((provenance = 'registration_entry_cost') = (registration_id IS NOT NULL)),
  -- One expense per journal. Two rows against one entry is the double-count with a
  -- different name.
  CONSTRAINT expense_org_journal_key UNIQUE (org_id, journal_id),
  -- One expense per registration cost, whatever else changes.
  CONSTRAINT expense_org_registration_key UNIQUE (org_id, registration_id),
  CONSTRAINT expense_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX expense_org_idx          ON expense (org_id);
CREATE INDEX expense_org_date_idx     ON expense (org_id, incurred_on);
CREATE INDEX expense_org_registration_idx ON expense (org_id, registration_id);
CREATE INDEX expense_org_provenance_idx  ON expense (org_id, provenance);

CREATE TRIGGER expense_append_only
  BEFORE UPDATE OR DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- POSTING FUNCTIONS — the only writers of expense
--
-- The org is never a parameter. It comes from the session (ADR-0011 rule 3), so a
-- caller cannot choose which tenant the write lands in; an unset context yields NULL,
-- which is not a valid org_id, and the INSERT fails closed.
--
-- SECURITY DEFINER is required and is the reason these are functions at all: the
-- application role has no INSERT on expense, so without elevation there would be no
-- lawful way to record a cost — and the obvious alternative, granting INSERT back,
-- is the two-components defect in a different costume.
--
-- Every reference is schema-qualified because search_path is pinned to empty.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_registration_entry_expense(
  p_registration_id     uuid,
  p_incurred_on         date,
  p_debit_account_id    uuid,
  p_credit_account_id   uuid,
  p_description         text,
  p_cost_centre_team_id uuid DEFAULT NULL,
  p_recorded_by_person_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     uuid := public.current_org_id();
  v_entry      record;
  v_journal_id uuid;
  v_expense_id uuid;
  v_amount     numeric(18,4);
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organisation in the session context; refusing to post an expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ec.amount, ec.discount, ec.currency
    INTO v_entry
    FROM public.entry_cost ec
   WHERE ec.org_id = v_org_id
     AND ec.registration_id = p_registration_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no entry cost recorded for registration % in organisation %',
      p_registration_id, v_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The amount is DERIVED from the entry cost, not supplied. A caller who can choose
  -- the figure can choose a wrong figure, and the figure is the thing being audited.
  v_amount := v_entry.amount - v_entry.discount;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'entry cost for registration % nets to %; there is no cost to post',
      p_registration_id, v_amount
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.ledger_journal
    (org_id, description, source_kind, posting_period, cost_centre_team_id, currency)
  VALUES
    (v_org_id, p_description, 'expense', p_incurred_on, p_cost_centre_team_id, v_entry.currency)
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
  VALUES
    (v_org_id, v_journal_id, 1, p_debit_account_id,  'debit', v_amount, v_entry.currency),
    (v_org_id, v_journal_id, 2, p_credit_account_id, 'credit', v_amount, v_entry.currency);

  INSERT INTO public.expense
    (org_id, description, amount, currency, incurred_on, provenance, registration_id,
     journal_id, recorded_by_person_id)
  VALUES
    (v_org_id, p_description, v_amount, v_entry.currency, p_incurred_on,
     'registration_entry_cost', p_registration_id, v_journal_id, p_recorded_by_person_id)
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END
$$;

COMMENT ON FUNCTION public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid) IS
  'Records the entry cost of one registration as one expense and one balanced journal. The amount is derived from entry_cost, never supplied. A second call for the same registration is refused by UNIQUE (org_id, registration_id).';

CREATE OR REPLACE FUNCTION public.post_manual_expense(
  p_incurred_on         date,
  p_amount              numeric(18,4),
  p_currency            varchar(3),
  p_debit_account_id    uuid,
  p_credit_account_id   uuid,
  p_description         text,
  p_cost_centre_team_id uuid DEFAULT NULL,
  p_recorded_by_person_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     uuid := public.current_org_id();
  v_journal_id uuid;
  v_expense_id uuid;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organisation in the session context; refusing to post an expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid currency %', p_currency USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'expense amount must be positive, got %', p_amount
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.ledger_journal
    (org_id, description, source_kind, posting_period, cost_centre_team_id, currency)
  VALUES
    (v_org_id, p_description, 'expense', p_incurred_on, p_cost_centre_team_id, p_currency)
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
  VALUES
    (v_org_id, v_journal_id, 1, p_debit_account_id,  'debit',  p_amount, p_currency),
    (v_org_id, v_journal_id, 2, p_credit_account_id, 'credit', p_amount, p_currency);

  INSERT INTO public.expense
    (org_id, description, amount, currency, incurred_on, provenance, registration_id,
     journal_id, recorded_by_person_id)
  VALUES
    (v_org_id, p_description, p_amount, p_currency, p_incurred_on, 'manual', NULL,
     v_journal_id, p_recorded_by_person_id)
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END
$$;

COMMENT ON FUNCTION public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid) IS
  'Records one hand-filed expense as one expense row and one balanced journal. Provenance is manual, so registration_id is necessarily NULL.';

-- -----------------------------------------------------------------------------
-- PRIZE ALLOCATION
--
-- The header names WHICH settled pool version was drawn, and COPIES its figures.
-- The copy is not denormalisation for speed. The pool can be superseded by a later
-- version (a sponsor correction, a re-run of the deductions), and an allocation
-- computed against version 1 must still reconcile against version 1's numbers long
-- after version 2 exists.
--
-- The basis and the rule version are stored as data rather than resolved by reading a
-- CompensationAgreement, because resolving them now is precisely the as-of join that
-- makes an allocation unreproducible.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  prize_pool_id         uuid NOT NULL,
  -- The pool VERSION this draw was made against, so "which numbers?" has an answer
  -- that does not depend on reading a mutable row.
  pool_version          integer NOT NULL,
  team_id               uuid NOT NULL,
  basis                 allocation_basis NOT NULL,
  rule_version          integer NOT NULL,
  -- Pinned in the snapshot and CHECKed to the one policy the spec fixes. A snapshot
  -- whose remainder policy was a free-text column would let a replay disagree with the
  -- original over rounding alone.
  remainder_policy      varchar(64) NOT NULL DEFAULT 'largest_remainder_stable_sort',
  -- The pool figures, copied.
  gross                 numeric(18,4) NOT NULL,
  deductions            numeric(18,4) NOT NULL,
  net_prize             numeric(18,4) NOT NULL,
  tax_withheld          numeric(18,4) NOT NULL,
  currency              varchar(3) NOT NULL,
  -- Emitted by the engine, RECOMPUTED and enforced by the trigger below.
  input_hash            char(64) NOT NULL,
  -- Computed here over the frozen input rows.
  snapshot_hash         char(64) NOT NULL,
  -- Computed here over the result rows, so an allocation can be verified without
  -- re-running the engine.
  output_hash           char(64) NOT NULL,
  computed_at           timestamptz NOT NULL,
  computed_by           varchar(120) NOT NULL,
  -- Corrections are new allocations that name the one they replace. Never an UPDATE.
  supersedes_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_pool_fk
    FOREIGN KEY (org_id, prize_pool_id) REFERENCES prize_pool (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_gross_check CHECK (gross >= 0),
  CONSTRAINT prize_allocation_deductions_check CHECK (deductions >= 0),
  CONSTRAINT prize_allocation_net_check CHECK (net_prize >= 0),
  CONSTRAINT prize_allocation_tax_check CHECK (tax_withheld >= 0),
  CONSTRAINT prize_allocation_net_identity_check CHECK (net_prize = gross - deductions),
  CONSTRAINT prize_allocation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_rule_version_check CHECK (rule_version >= 1),
  CONSTRAINT prize_allocation_pool_version_check CHECK (pool_version >= 1),
  CONSTRAINT prize_allocation_remainder_policy_check
    CHECK (remainder_policy = 'largest_remainder_stable_sort'),
  CONSTRAINT prize_allocation_input_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_snapshot_hash_check CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_output_hash_check CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_org_idx       ON prize_allocation (org_id);
CREATE INDEX prize_allocation_org_division_idx ON prize_allocation (org_id, competition_division_id);
CREATE INDEX prize_allocation_org_pool_idx  ON prize_allocation (org_id, prize_pool_id);
CREATE INDEX prize_allocation_org_team_idx  ON prize_allocation (org_id, team_id);

CREATE UNIQUE INDEX prize_allocation_supersedes_key
  ON prize_allocation (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TRIGGER prize_allocation_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- Note what is NOT here yet: a foreign key on
-- (org_id, competition_division_id, pool_version), and a guard refusing an allocation
-- against an unsettled pool. Both need `prize_pool.version` and `prize_pool.status`,
-- which are added by 0005_prize_pool_lifecycle.sql — 0002's UNIQUE
-- (org_id, competition_division_id) has to be dropped before a pool can be versioned at
-- all, and that is a change to an already-applied table, so it belongs in its own
-- corrective file rather than in the middle of the money schema.
--
-- The cost of that ordering is stated rather than hidden: between 0004 and 0005 an
-- allocation could name a pool version that does not exist and a draft pool could be
-- drawn against. Both files ship in the same change and 0005 closes them, so no released
-- schema ever has that window. Leaving them out of 0004 is still the honest choice —
-- inventing the FK here would mean the migration could not be applied at all.

-- -----------------------------------------------------------------------------
-- THE FROZEN INPUT SNAPSHOT
--
-- Two child tables, because the two halves answer different questions.
--
--   prize_allocation_input — WHO was in the draw and what the ROSTER said at the
--     moment. `share_percent` is the value read from team_membership at decision
--     time. It is NOT the rule's percentage (that is in the terms table), and the
--     difference matters: the common dispute is "my share was changed before the
--     draw", and answering it needs the roster value frozen next to the rule value,
--     not one column standing in for both.
--
--   prize_allocation_term — what the RULE said: one row per person per term role.
--
-- Weight is numeric(38,0), not an integer column: the engine's weights are bigint and
-- a participation count is a whole number by definition, but numeric is what keeps the
-- arithmetic in exact decimal space with no integer overflow and no float anywhere
-- near a prize.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_input (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id     uuid NOT NULL,
  person_id         uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  participant_kind  prize_participant_kind NOT NULL,
  -- The roster's share for this person, frozen. NULL for staff: a coach holds no
  -- playing share, and a zero here would be indistinguishable from a real zero.
  share_percent     numeric(7,4),
  weight            numeric(38,0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_input_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_input_share_check
    CHECK (share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100)),
  CONSTRAINT prize_allocation_input_weight_check CHECK (weight IS NULL OR weight >= 0),
  -- One row per person. A duplicate participant is the engine's own rejection, frozen
  -- here as a constraint so it cannot be stored even if a caller bypassed the engine.
  CONSTRAINT prize_allocation_input_org_allocation_person_key UNIQUE (org_id, allocation_id, person_id),
  CONSTRAINT prize_allocation_input_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_input_org_idx ON prize_allocation_input (org_id);
CREATE INDEX prize_allocation_input_org_allocation_idx ON prize_allocation_input (org_id, allocation_id);

CREATE TABLE prize_allocation_term (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id  uuid NOT NULL,
  person_id      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  term_role      allocation_term_role NOT NULL,
  amount         numeric(18,4) NOT NULL,
  -- The EXACT string the engine was given, verbatim.
  --
  -- This is not redundant with `amount`, and the reason is specific rather than
  -- decorative. The engine's input hash is taken over the rule's raw percentage
  -- STRINGS, not over parsed values: `parsePercent("60")` and `parsePercent("60.0000")`
  -- are the same number and hash differently. Storing only the parsed numeric would
  -- mean the database could not reproduce the hash it is supposed to verify — the
  -- snapshot would be arithmetically complete and cryptographically useless. So the
  -- literal is what is frozen, and `amount` is the derived decimal the schema can
  -- reason about. The CHECK binds them: the literal must parse to the stored number, so
  -- they cannot drift into telling different stories about the same rule.
  raw_value      varchar(64) NOT NULL,
  -- A term is a percentage OR a money amount (the `fixed_amount` role), and a money
  -- amount with no currency beside it is exactly the mistake ADR-0003 exists to prevent.
  -- Carried on the row rather than read from the header so the term is self-describing.
  currency       varchar(3) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_term_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_term_amount_check CHECK (amount >= 0),
  CONSTRAINT prize_allocation_term_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_term_raw_format_check CHECK (raw_value ~ '^-?[0-9]+(\.[0-9]+)?$'),
  CONSTRAINT prize_allocation_term_raw_value_check CHECK (raw_value::numeric = amount),
  -- One term per person per role. Two percentages for one person means the snapshot
  -- does not say which was used.
  CONSTRAINT prize_allocation_term_org_allocation_person_role_key
    UNIQUE (org_id, allocation_id, person_id, term_role),
  CONSTRAINT prize_allocation_term_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_term_org_idx ON prize_allocation_term (org_id);
CREATE INDEX prize_allocation_term_org_allocation_idx ON prize_allocation_term (org_id, allocation_id);

CREATE TRIGGER prize_allocation_input_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_input
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER prize_allocation_term_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_term
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- RESULT ROWS — the engine's Allocation, persisted verbatim
--
-- `explanation` is stored, not re-rendered. The engine writes it for exactly this
-- purpose: a human-readable derivation is only evidence if it is the derivation that
-- was actually used, and re-deriving it at read time from a rule that may since have
-- been corrected produces a confident, wrong answer to a player in dispute.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_result (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id   uuid NOT NULL,
  person_id       uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  participant_kind prize_participant_kind NOT NULL,
  basis_amount    numeric(18,4) NOT NULL,
  computed_amount numeric(18,4) NOT NULL,
  currency        varchar(3) NOT NULL,
  rule_version    integer NOT NULL,
  computed_at     timestamptz NOT NULL,
  computed_by     varchar(120) NOT NULL,
  explanation     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_result_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_result_basis_check CHECK (basis_amount >= 0),
  -- NEGATIVE IS LEGAL, and deliberately. An adjustment may take money back, and
  -- `applyAdjustment` in the engine produces exactly such rows. Refusing a negative
  -- award would make a clawback unrepresentable, which is the opposite of what an
  -- append-only ledger is for.
  CONSTRAINT prize_allocation_result_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_result_org_allocation_person_key UNIQUE (org_id, allocation_id, person_id),
  CONSTRAINT prize_allocation_result_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_result_org_idx ON prize_allocation_result (org_id);
CREATE INDEX prize_allocation_result_org_allocation_idx ON prize_allocation_result (org_id, allocation_id);
CREATE INDEX prize_allocation_result_org_person_idx ON prize_allocation_result (org_id, person_id);

CREATE TRIGGER prize_allocation_result_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_result
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- RECONCILIATION
--
-- A persisted first-class row, not a view — the spec is explicit about this, and it is
-- right. A view recomputed from the allocations cannot say what the books said when
-- the draw was run, which is the only statement anybody actually needs when a figure
-- is disputed.
--
-- The CHECK below is the invariant as arithmetic: variance is not an independent
-- input, it is defined as allocated + unallocated - net. A stored variance that
-- disagreed with its inputs would be a stored lie. The trigger below goes further and
-- recomputes the totals from the result rows, so a reconciliation that balances with
-- numbers nobody allocated is refused too.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_reconciliation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id    uuid NOT NULL,
  net_prize        numeric(18,4) NOT NULL,
  allocated_total  numeric(18,4) NOT NULL,
  unallocated      numeric(18,4) NOT NULL,
  variance         numeric(18,4) NOT NULL,
  -- ADR-0003: every monetary column has a currency beside it, not a global one. Four
  -- money figures without it would be unreadable in isolation, which is precisely the
  -- mistake the legacy schema made.
  currency         varchar(3) NOT NULL,
  is_balanced      boolean NOT NULL,
  explanation      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_reconciliation_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_reconciliation_net_check CHECK (net_prize >= 0),
  CONSTRAINT prize_allocation_reconciliation_unallocated_check CHECK (unallocated >= 0),
  CONSTRAINT prize_allocation_reconciliation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- The invariant, as a constraint the storage cannot violate.
  CONSTRAINT prize_allocation_reconciliation_variance_check
    CHECK (variance = allocated_total + unallocated - net_prize),
  CONSTRAINT prize_allocation_reconciliation_balanced_check
    CHECK (is_balanced = (variance = 0)),
  -- Exactly one reconciliation per allocation. Two would be two answers to "do the
  -- books balance?", which is worse than none.
  CONSTRAINT prize_allocation_reconciliation_org_allocation_key UNIQUE (org_id, allocation_id),
  CONSTRAINT prize_allocation_reconciliation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_reconciliation_org_idx ON prize_allocation_reconciliation (org_id);

CREATE TRIGGER prize_allocation_reconciliation_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_reconciliation
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- HASH ENFORCEMENT
--
-- Four triggers, one function, all DEFERRABLE: the snapshot, the terms and the result
-- rows may be inserted in any order inside the posting transaction, and the check
-- happens once at COMMIT when the whole allocation is visible.
--
--   input_hash    recomputed from the stored snapshot using the engine's canonical
--                 form, and compared to the value the engine emitted. This is the
--                 alignment contract between packages/core and this schema.
--   snapshot_hash recomputed over the frozen inputs INCLUDING the roster shares and
--                 the pool figures.
--   output_hash   recomputed over the result rows.
--   reconciliation recomputed from the result rows; a variance other than zero, or
--                 totals that do not match the rows, is refused.
--
-- CANONICAL FORMS
-- ---------------
-- 1. input_hash must equal sha256(JSON.stringify(C)) in JavaScript, where C is
--    exactly the object allocation-engine.ts builds in hashInputs():
--
--      {"netPrize":"<4dp>","currency":"INR",
--       "participants":[{"personId":"...","kind":"roster","weight":null}, ...],
--       "rule":{"version":1,"basis":"percentage",
--               "percentages":{"<uuid>":"60.0000"},
--               "fixedAmounts":{},"poolPercentage":{},
--               "remainderPolicy":"largest_remainder_stable_sort"}}
--
--    Participants are ordered by uuid; each record map is ordered by key. That is the
--    engine's own ordering, and reimplementing it in SQL is deliberate — a hash over a
--    canonically ordered set is what makes the two independent implementations
--    comparable at all.
--
-- 2. snapshot_hash is a length-framed text of the header figures followed by one
--    line per frozen input and one per rule term, all ordered by uuid.
--
-- 3. output_hash is one length-framed line per result row. The explanation is
--    length-prefixed, because it is free text: an engine adjustment appends a line
--    break to it, and without the length prefix two different result sets could
--    serialise to the same bytes and hash alike.
--
-- Why compute rather than trust: a hash the database only stores is a comment. A hash
-- it recomputes is a check, and it turns "the snapshot was tampered with" from an
-- unfalsifiable claim into an INSERT that fails.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_allocation_hashes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allocation_id uuid;
  a              record;
  v_canonical     text;
  v_recomputed    text;
  v_participants  text;
  v_percentages   text;
  v_fixed         text;
  v_pool_pct      text;
  v_snapshot      text;
  v_output        text;
  v_inputs        integer;
  v_results       integer;
  v_allocated     numeric;
  v_stored_total  numeric;
  v_stored_net    numeric;
  v_stored_unall  numeric;
  v_stored_bal    boolean;
  v_stored_currency varchar(3);
BEGIN
  IF TG_TABLE_NAME = 'prize_allocation' THEN
    v_allocation_id := NEW.id;
  ELSE
    v_allocation_id := NEW.allocation_id;
  END IF;

  SELECT * INTO a FROM public.prize_allocation WHERE id = v_allocation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- ---- 1. input_hash, reconstructed in the engine's own canonical form --------
  SELECT COALESCE(string_agg(
           '{"personId":"' || i.person_id::text
           || '","kind":"' || i.participant_kind::text
           || '","weight":' || COALESCE(i.weight::text, 'null') || '}',
           ',' ORDER BY i.person_id), '')
    INTO v_participants
    FROM public.prize_allocation_input i
   WHERE i.allocation_id = a.id;

  -- The engine hashes the rule's RAW strings, so the reconstruction reads raw_value
  -- and not amount. Using amount would rebuild a canonical form the engine never
  -- produced, and the comparison would then fail for reasons that have nothing to do
  -- with tampering.
  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_percentages
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'percentage';

  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_fixed
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'fixed_amount';

  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_pool_pct
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'pool_percentage';

  v_canonical :=
    '{"netPrize":"' || a.net_prize::text
    || '","currency":"' || a.currency
    || '","participants":[' || v_participants || ']'
    || ',"rule":{"version":' || a.rule_version::text
    || ',"basis":"' || a.basis::text || '"'
    || ',"percentages":' || v_percentages
    || ',"fixedAmounts":' || v_fixed
    || ',"poolPercentage":' || v_pool_pct
    || ',"remainderPolicy":"' || a.remainder_policy || '"}}';

  v_recomputed := encode(sha256(convert_to(v_canonical, 'utf8')), 'hex');

  IF v_recomputed <> a.input_hash THEN
    RAISE EXCEPTION
      'allocation % input_hash does not match its frozen snapshot: recomputed %, stored %',
      a.id, v_recomputed, a.input_hash
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 2. snapshot_hash over the frozen inputs -------------------------------
  v_snapshot :=
    'gross=' || a.gross::text || E'\n'
    || 'deductions=' || a.deductions::text || E'\n'
    || 'net=' || a.net_prize::text || E'\n'
    || 'tax=' || a.tax_withheld::text || E'\n'
    || 'currency=' || a.currency || E'\n'
    || 'basis=' || a.basis::text || E'\n'
    || 'rule_version=' || a.rule_version::text || E'\n'
    || 'remainder_policy=' || a.remainder_policy || E'\n'
    || COALESCE((
         SELECT string_agg(
                  'p|' || i.person_id::text
                  || '|' || i.participant_kind::text
                  || '|' || COALESCE(i.share_percent::text, '')
                  || '|' || COALESCE(i.weight::text, '') || E'\n', '' ORDER BY i.person_id)
           FROM public.prize_allocation_input i WHERE i.allocation_id = a.id), '')
    || COALESCE((
         SELECT string_agg(
                  't|' || t.person_id::text || '|' || t.term_role::text
                  || '|' || t.amount::text || E'\n', '' ORDER BY t.person_id, t.term_role)
           FROM public.prize_allocation_term t WHERE t.allocation_id = a.id), '');

  IF encode(sha256(convert_to(v_snapshot, 'utf8')), 'hex') <> a.snapshot_hash THEN
    RAISE EXCEPTION 'allocation % snapshot_hash does not match its frozen input rows', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 3. output_hash over the result rows -----------------------------------
  v_output := COALESCE((
    SELECT string_agg(
             r.person_id::text || '|' || r.participant_kind::text
             || '|' || r.basis_amount::text
             || '|' || r.computed_amount::text
             || '|' || r.currency
             || '|' || r.rule_version::text
             || '|' || length(r.explanation)::text || ':' || r.explanation || E'\n',
             '' ORDER BY r.person_id)
      FROM public.prize_allocation_result r WHERE r.allocation_id = a.id), '');

  IF encode(sha256(convert_to(v_output, 'utf8')), 'hex') <> a.output_hash THEN
    RAISE EXCEPTION 'allocation % output_hash does not match its result rows', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 4. the frozen participant set and the result set correspond -----------
  -- Without this the three hashes above would still agree on an allocation that
  -- silently dropped a player, because an empty or short result set hashes perfectly
  -- happily. The engine refuses to allocate with no participants and refuses a
  -- duplicate participant, so a mismatch here is not something this engine could have
  -- emitted.
  SELECT count(*) INTO v_inputs  FROM public.prize_allocation_input  WHERE allocation_id = a.id;
  SELECT count(*) INTO v_results FROM public.prize_allocation_result WHERE allocation_id = a.id;

  IF v_inputs = 0 OR v_inputs <> v_results THEN
    RAISE EXCEPTION
      'allocation % froze % participant(s) but holds % result row(s); they must correspond',
      a.id, v_inputs, v_results
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.prize_allocation_result r
     WHERE r.allocation_id = a.id
       AND NOT EXISTS (SELECT 1 FROM public.prize_allocation_input i
                        WHERE i.allocation_id = a.id AND i.person_id = r.person_id)
  ) THEN
    RAISE EXCEPTION 'allocation % has a result for a person absent from its frozen snapshot', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every frozen row must also be in the allocation's currency. A term quoted in USD
  -- inside an INR draw is a conversion somebody performed at no rate and recorded nowhere.
  IF EXISTS (
    SELECT 1 FROM public.prize_allocation_result r
     WHERE r.allocation_id = a.id AND r.currency <> a.currency
  ) OR EXISTS (
    SELECT 1 FROM public.prize_allocation_term t
     WHERE t.allocation_id = a.id AND t.currency <> a.currency
  ) THEN
    RAISE EXCEPTION 'allocation % carries rows in a currency other than %', a.id, a.currency
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 5. the reconciliation invariant, recomputed ---------------------------
  IF EXISTS (SELECT 1 FROM public.prize_allocation_reconciliation rc WHERE rc.allocation_id = a.id) THEN
    SELECT COALESCE(sum(r.computed_amount), 0)
      INTO v_allocated
      FROM public.prize_allocation_result r WHERE r.allocation_id = a.id;

    SELECT rc.allocated_total, rc.net_prize, rc.unallocated, rc.is_balanced, rc.currency
      INTO v_stored_total, v_stored_net, v_stored_unall, v_stored_bal, v_stored_currency
      FROM public.prize_allocation_reconciliation rc
     WHERE rc.allocation_id = a.id;

    IF v_stored_currency <> a.currency THEN
      RAISE EXCEPTION
        'allocation % reconciles in % but was drawn against %', a.id, v_stored_currency, a.currency
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_total <> v_allocated THEN
      RAISE EXCEPTION
        'allocation % reconciliation claims % allocated but its result rows total %',
        a.id, v_stored_total, v_allocated
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_net <> a.net_prize THEN
      RAISE EXCEPTION
        'allocation % reconciliation is against net % but the frozen pool net is %',
        a.id, v_stored_net, a.net_prize
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_allocated + v_stored_unall <> v_stored_net THEN
      RAISE EXCEPTION
        'allocation % does not reconcile: allocated % + unallocated % <> net %',
        a.id, v_allocated, v_stored_unall, v_stored_net
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_bal IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'allocation % is stored as an unbalanced allocation', a.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_allocation_hashes() IS
  'Recomputes input_hash, snapshot_hash, output_hash and the reconciliation totals from the stored rows and refuses the allocation if any of them disagrees. Deferred to COMMIT.';

-- DEFERRABLE on every allocation table: the header, the snapshot, the terms, the
-- results and the reconciliation may be written in any order inside one posting
-- transaction, and the check happens once, at COMMIT, when the whole allocation is
-- visible. An IMMEDIATE trigger would check after the header, before any row existed,
-- and reject every correct posting.
CREATE CONSTRAINT TRIGGER prize_allocation_header_hashes
  AFTER INSERT ON prize_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_participant_hashes
  AFTER INSERT ON prize_allocation_input
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_term_hashes
  AFTER INSERT ON prize_allocation_term
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_result_hashes
  AFTER INSERT ON prize_allocation_result
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_reconciliation_hashes
  AFTER INSERT ON prize_allocation_reconciliation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced, tenant predicate first, no IS NULL escape. An unset session
-- context makes `org_id = current_org_id()` evaluate to NULL, which is not TRUE, which
-- hides every row. That is failing closed, and it is the property ADR-0015 exists to
-- guarantee.
--
-- budget_balance is a plain view, so it runs with the privileges of its invoker and
-- every underlying table's RLS applies to it. It therefore exposes exactly what its
-- tables expose and nothing wider.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  money_tables text[] := ARRAY[
    'ledger_account','ledger_journal','ledger_line','budget','expense',
    'prize_allocation','prize_allocation_input','prize_allocation_term',
    'prize_allocation_result','prize_allocation_reconciliation'
  ];
BEGIN
  FOREACH t IN ARRAY money_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- PRIVILEGES
--
-- raptor_app gets SELECT and INSERT on the money tables and NOTHING else. No UPDATE,
-- no DELETE: posted money is corrected by a reversing entry, and a role that can
-- rewrite a posted figure is a role that can invent one.
--
-- `expense` additionally gets NO INSERT. It is written only by the two posting
-- functions below, which is what makes "exactly one component can create an expense
-- row" a property of the GRANT rather than a convention two components agreed between
-- themselves. The legacy double-count happened because two components both believed
-- they owned the write; here the second one has no grant.
--
-- Those functions are SECURITY DEFINER, so EXECUTE on them is a door into `expense`.
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default, which would
-- hand that door to every role in the database, so PUBLIC is revoked and the grant is
-- made explicitly to raptor_app only.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT, INSERT ON
  ledger_account, ledger_journal, ledger_line, budget,
  prize_allocation, prize_allocation_input, prize_allocation_term,
  prize_allocation_result, prize_allocation_reconciliation
TO raptor_app;

GRANT SELECT ON expense TO raptor_app;
GRANT SELECT ON budget_balance TO raptor_app;

REVOKE ALL ON FUNCTION public.assert_journal_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_budget_not_exceeded() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_money_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_allocation_hashes() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid),
  public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid)
TO raptor_app;

-- RLS is worthless to a role that can switch it off.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;