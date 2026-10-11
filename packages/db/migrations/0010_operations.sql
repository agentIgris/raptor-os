-- =============================================================================
-- packages/db/migrations/0010_operations.sql
--
-- OPERATIONS: tasks, workflow runs, travel, assets and facilities.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- ---------------------------------------------
-- The design spec closes Phase 6 on one sentence: "Tasks, workflows, travel,
-- assets, facilities provable end to end". Read carefully, the hard half of
-- that is the word PROVABLE. An operations tool that records "this task is done"
-- or "this laptop is with Priya" as a COLUMN is recording a claim. Four of the
-- five domains here have a specific historical failure to answer:
--
--   TASKS      A `status` column with a CHECK constraint can say what a row may
--              BE. It cannot say what a row may BECOME, because that is a
--              relation between two rows in time. So the legal transitions are
--              DATA in `task_state_transition`, seeded from the same table
--              `packages/core/src/tasks/task.ts` declares, and a trigger
--              refuses any move the table does not contain.
--
--   WORKFLOWS  A run is interrupted. Always. The design question is what the
--              second attempt is allowed to assume about the first, and the
--              answer is: the step record. `workflow_step_run` keeps its own
--              started_at, so a RESUMED step is distinguishable from a RESTARTED
--              one — which is the question an operator asks after an incident.
--              Every step carries a retry token derived from
--              (run_id, idempotency_scope) so a retry after a network timeout is
--              recognisable rather than performed twice.
--
--   TRAVEL     Travel for a minor carries guardian-sensitive detail and real
--              spend. ADR-0005's audit taxonomy has a `travel` class for exactly
--              this, and ADR-0016 records that the legacy system had no concept
--              of minors at all. So a trip traveller is REFUSED unless a guardian
--              consent exists that names THIS trip — and the consent must be
--              live, un-withdrawn, and the traveller must be over the floor.
--              `packages/core/src/minors` owns those rules; this file enforces
--              the storage of their evidence, not a second copy of them.
--
--   ASSETS     ADR-0016 found the legacy system could not say where a thing was.
--              The fix is structural: there is NO `holder_id` column anywhere in
--              this file. Custody is an append-only record and the holder is
--              DERIVED, exactly as `inventory_position` derives a stock balance in
--              0009 and for the same reason.
--
--   FACILITIES Double-booking. 0009 and 0006 both hit the same wall and both
--              record it: `btree_gist` is unavailable under PGlite and
--              `EXCLUDE USING gist` over uuid fails, so the overlap guard is a
--              TRIGGER, judged at COMMIT by a DEFERRABLE constraint trigger so a
--              batch of reservations is judged as a batch.
--
-- WHAT IS EXTENDED RATHER THAN DUPLICATED
-- ----------------------------------------
--   person, engagement, guardian_consent      0001 + 0008. Never recreated.
--   organization                               0001.
--
--   The guardian rules themselves live in 0008 (`guardian_consent_covers_in_org`)
--   and in `packages/core/src/minors`. This file STORES the evidence and calls
--   0008's function; it does not restate a majority threshold, and there is no
--   `is_minor` column anywhere in it — `trip_traveller.majority_at_travel` is a
--   DERIVED column maintained by a trigger from `person.birth_date`, so a
--   corrected date of birth corrects it everywhere at once rather than leaving
--   three copies to drift.
--
-- TENANCY
-- -------
-- Identical to 0001 through 0009 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK
-- between tenant tables composite and including org_id, RLS ENABLED *and*
-- FORCED with the tenant predicate as the whole policy and no IS NULL escape
-- (ADR-0015). `person` is org-independent by design (ADR-0018) and is therefore
-- referenced by single-column foreign keys, exactly as `engagement.person_id` is.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only
-- tables carry none, because on a table where UPDATE is impossible an archive
-- column is a column permanently NULL (0004's rule).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

-- The vocabulary is declared ONCE here and in `packages/core/src/tasks/task.ts`.
-- `tasks.operators.test.ts` asserts the two agree by name, so the domain and the
-- schema cannot drift without a test failing — which is the whole reason the
-- transition table is DATA rather than prose in either place.
--
-- EVERY type is schema-qualified, and every function body that names one is too.
-- That is not tidiness: the functions below pin `search_path` to empty, and a
-- body is PARSED AT CREATION, so an unqualified type name would not resolve
-- there. 0009 states the same rule and gives the same reason.
CREATE TYPE public.task_state AS ENUM (
  'open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'
);

CREATE TYPE public.task_priority AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TYPE public.workflow_run_status AS ENUM ('running', 'completed', 'declined', 'failed');

-- `failed` is DISTINCT from `completed`, not an outcome kind of it. A step that
-- errored ENDED without doing its work, and collapsing the two would let a
-- progress figure count it — the invented metric ADR-0019 was written against.
CREATE TYPE public.workflow_step_status AS ENUM ('pending', 'in_progress', 'completed', 'failed');

CREATE TYPE public.step_outcome_kind AS ENUM ('succeeded', 'declined', 'failed');

CREATE TYPE public.trip_status AS ENUM ('draft', 'awaiting_approval', 'approved', 'in_progress', 'completed', 'cancelled');

CREATE TYPE public.traveller_role AS ENUM ('player', 'staff', 'guardian', 'observer');

CREATE TYPE public.custody_kind AS ENUM ('issue', 'return', 'transfer', 'loss', 'disposal');

CREATE TYPE public.facility_reservation_state AS ENUM ('held', 'confirmed', 'cancelled');

-- -----------------------------------------------------------------------------
-- TASKS
-- -----------------------------------------------------------------------------

-- WHAT WAS PROMISED. `state` is the only mutable field, and a trigger refuses any
-- move the transition table does not contain — so a task cannot be born done,
-- and cannot skip review. See the file header.
CREATE TABLE task (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title           varchar(200) NOT NULL,
  description     text,
  state           task_state NOT NULL DEFAULT 'open',
  priority        task_priority NOT NULL DEFAULT 'normal',
  -- Single-column: `person` is org-independent by design (ADR-0018), and a task
  -- assigned to somebody from another organisation is a business question, not
  -- a referential one. It is NOT NULL for the same reason `in_progress` requires
  -- an assignee in the domain: a task nobody owns is a task nobody does.
  assignee_id     uuid REFERENCES person(id) ON DELETE RESTRICT,
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- WHEN the task last MOVED, not when the row was written. Backfilled history
  -- belongs to the period it happened in (ADR-0019 rule 5).
  transitioned_at timestamptz,
  state_changed_by uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- Required for `blocked` and `cancelled` and forbidden otherwise, by the same
  -- CHECK that binds evidence provenance in 0009: a reason beside a state that
  -- records no causation would read as authoritative and mean nothing.
  state_reason    varchar(400),
  -- THE TASK/WORKFLOW LINKAGE. Both null, or both set. A task a workflow step
  -- created names the run AND the step, so "which step produced this" is
  -- answerable from the task alone. A half-set pair is refused by the CHECK
  -- rather than completed with a guess.
  origin_run_id     uuid,
  origin_step_id    uuid,
  archived_at     timestamptz,
  CONSTRAINT task_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT task_state_reason_check CHECK (
        (state IN ('blocked', 'cancelled') AND state_reason IS NOT NULL AND btrim(state_reason) <> '')
     OR (state NOT IN ('blocked', 'cancelled') AND state_reason IS NULL)
      ),
  CONSTRAINT task_due_after_creation_check CHECK (due_at IS NULL OR due_at > created_at),
  CONSTRAINT task_transitioned_fields_check CHECK (
        (transitioned_at IS NULL AND state_changed_by IS NULL)
     OR (transitioned_at IS NOT NULL AND state_changed_by IS NOT NULL)
      ),
  CONSTRAINT task_origin_pair_check CHECK (
        (origin_run_id IS NULL AND origin_step_id IS NULL)
     OR (origin_run_id IS NOT NULL AND origin_step_id IS NOT NULL)
      ),
  CONSTRAINT task_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_org_idx             ON task (org_id);
CREATE INDEX task_org_state_idx       ON task (org_id, state);
CREATE INDEX task_org_assignee_idx    ON task (org_id, assignee_id);
CREATE INDEX task_org_due_idx         ON task (org_id, due_at);
CREATE INDEX task_org_origin_idx      ON task (org_id, origin_run_id, origin_step_id);
CREATE INDEX task_org_priority_idx    ON task (org_id, priority, due_at);

COMMENT ON TABLE task IS
  'A unit of work. `state` is the ONLY mutable field and every move is checked against task_state_transition at COMMIT. `done` is unreachable except through in_review, so a completed task has by construction passed a state somebody looked at. NO stored derived counts and NO stored progress: those are the stored-flag drift ADR-0016 records.';

-- THE LEGAL TRANSITIONS, AS DATA. The same table `packages/core/src/tasks/task.ts`
-- exports as `TASK_TRANSITIONS`; `tasks.operators.test.ts` asserts the two agree.
--
-- Seeded per organisation, exactly as 0008 seeds `hr_state_transition` and 0009
-- seeds `partner_state_transition`, and with the same argument: an organisation
-- whose transition table is empty refuses every move rather than accepting every
-- one. Empty-means-nothing-legal is the safe direction.
CREATE TABLE task_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   task_state NOT NULL,
  to_state     task_state NOT NULL,
  -- NO self-edge. `x -> x` is a no-op that reads as a second occurrence of the
  -- thing, and in an append-only transition log it would inflate the count of
  -- real moves.
  CONSTRAINT task_state_transition_no_self_edge_check CHECK (from_state <> to_state),
  -- One edge per (from, to). A duplicate would make "which rules apply here" a
  -- question with two answers.
  CONSTRAINT task_state_transition_edge_key UNIQUE (org_id, from_state, to_state),
  -- ADR-0011 requires UNIQUE (org_id, id) on every tenant table so that a child
  -- table may reference one by the composite form. This table has no child today,
  -- which is exactly why it is easy to omit — and exactly why it should not be,
  -- because the next table to reference a transition edge would then be unable
  -- to do so with a composite FK and would fall back to a single-column one,
  -- reopening the isolation hole this convention exists to close.
  CONSTRAINT task_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_state_transition_org_idx ON task_state_transition (org_id);

COMMENT ON TABLE task_state_transition IS
  'The legal task transitions for one organisation, as DATA. Seeded from the same table packages/core declares; a trigger refuses any state change not present here. Immutable governance: only a migration or an operator changes it.';

-- Dependencies as EDGES rather than a self-referencing id list, because a cycle in
-- a self-list needs a recursive CTE to detect and an edge set does not.
--
-- The database does NOT try to detect cycles here, and that is a decision rather
-- than an omission: a cycle is a SCHEDULING property of a whole graph, and
-- `packages/core/src/tasks/dependencies.ts` owns it with a three-colour DFS. What
-- the database does own is the weaker, row-local guarantee — a dependency must
-- name a task that EXISTS in the same organisation — which a composite FK gives
-- structurally (ADR-0011). The cycle refusal is tested in core, where the
-- algorithm lives, and the test file here says so rather than implying otherwise.
CREATE TABLE task_dependency (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The blocked task.
  task_id             uuid NOT NULL,
  -- The blocker. Composite FK, so a cross-tenant dependency cannot be created
  -- even by a careless developer: the referenced row does not exist in the other
  -- organisation, so the insert fails.
  depends_on_task_id  uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_dependency_task_fk
    FOREIGN KEY (org_id, task_id) REFERENCES task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT task_dependency_blocker_fk
    FOREIGN KEY (org_id, depends_on_task_id) REFERENCES task (org_id, id) ON DELETE RESTRICT,
  -- A task blocked by itself is the degenerate cycle and is unreadable on a
  -- board as well as unschedulable.
  CONSTRAINT task_dependency_no_self_check CHECK (task_id <> depends_on_task_id),
  CONSTRAINT task_dependency_edge_key UNIQUE (org_id, task_id, depends_on_task_id),
  CONSTRAINT task_dependency_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_dependency_org_idx      ON task_dependency (org_id);
CREATE INDEX task_dependency_org_task_idx ON task_dependency (org_id, task_id);
CREATE INDEX task_dependency_org_block_idx ON task_dependency (org_id, depends_on_task_id);

COMMENT ON TABLE task_dependency IS
  'Task A depends on task B: A may not start until B is done. Composite FKs make a cross-organisation dependency structurally impossible (ADR-0011). CYCLE detection is NOT here — it is a property of the whole graph and lives in packages/core/src/tasks/dependencies.ts with a three-colour DFS; this table guarantees only that every edge names a real task in the same organisation.';

-- WHAT HAPPENED. Append-only: a transition is a fact about a moment, so a
-- correction is a new row, never an UPDATE of the old one. There is no
-- `archived_at` here because UPDATE is impossible (0004's rule).
CREATE TABLE task_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,
  from_state   task_state NOT NULL,
  to_state     task_state NOT NULL,
  -- WHEN the move happened, not when the row was written. A backfilled
  -- transition belongs to the day it happened (ADR-0019 rule 5).
  occurred_at  timestamptz NOT NULL,
  actor_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- Required for `blocked` and `cancelled`, forbidden otherwise — the same binding
  -- `task.state_reason_check` enforces on the row itself, asserted here so a
  -- transition LOG cannot disagree with the task it describes. A log entry that
  -- recorded a cancellation with no reason would be a record of a decision
  -- nobody could be shown.
  reason       varchar(400),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_transition_task_fk
    FOREIGN KEY (org_id, task_id) REFERENCES task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT task_transition_no_self_edge_check CHECK (from_state <> to_state),
  CONSTRAINT task_transition_reason_check CHECK (
        (to_state IN ('blocked', 'cancelled') AND reason IS NOT NULL AND btrim(reason) <> '')
     OR (to_state NOT IN ('blocked', 'cancelled') AND reason IS NULL)
      ),
  CONSTRAINT task_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_transition_org_idx       ON task_transition (org_id);
CREATE INDEX task_transition_org_task_idx  ON task_transition (org_id, task_id);
CREATE INDEX task_transition_org_time_idx  ON task_transition (org_id, occurred_at);

COMMENT ON TABLE task_transition IS
  'One recorded task move: what it was, what it became, when, and who. Append-only with no archived_at, because UPDATE is impossible — a mistake is corrected by a further transition, not by editing this one.';

-- -----------------------------------------------------------------------------
-- WORKFLOWS
-- -----------------------------------------------------------------------------

-- THE SHAPE of a process. No state of its own, which is the point: two runs of
-- one definition execute concurrently and must not be able to see each other.
CREATE TABLE workflow_definition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  slug           varchar(80) NOT NULL,
  name           varchar(200) NOT NULL,
  -- An INSTANT, supplied rather than defaulted from a clock, so a definition
  -- imported from another system keeps its real age.
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT workflow_definition_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT workflow_definition_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT workflow_definition_org_slug_key UNIQUE (org_id, slug),
  CONSTRAINT workflow_definition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_definition_org_idx ON workflow_definition (org_id);

CREATE TABLE workflow_step_definition (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  definition_id      uuid NOT NULL,
  step_id            varchar(80) NOT NULL,
  title              varchar(200) NOT NULL,
  -- ZERO-BASED and EXPLICIT rather than derived from array position or a
  -- sequence: step order IS the workflow, and "quote, approve, book" sorted
  -- alphabetically becomes "approve, book, quote" — a process that approves a
  -- quote nobody has written.
  position           integer NOT NULL,
  -- Names the real-world effect and is UNIQUE within the definition. The run's
  -- retry token is derived from it, so it is what a downstream system dedupes
  -- on. Two steps sharing one scope would share one token, and a retry of the
  -- first would be swallowed by the second's record.
  idempotency_scope  varchar(120) NOT NULL,
  -- Whether this step must record an outcome. Set on any step that can end
  -- without doing its work, so "declined" and "never reached" stay distinct.
  outcome_required   boolean NOT NULL DEFAULT false,
  -- A step that may only be started after this instant.
  not_before         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_definition_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES workflow_definition (org_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_step_definition_step_key UNIQUE (org_id, definition_id, step_id),
  CONSTRAINT workflow_step_definition_position_key UNIQUE (org_id, definition_id, position),
  CONSTRAINT workflow_step_definition_scope_key UNIQUE (org_id, definition_id, idempotency_scope),
  CONSTRAINT workflow_step_definition_position_check CHECK (position >= 0),
  CONSTRAINT workflow_step_definition_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT workflow_step_definition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_step_definition_org_idx ON workflow_step_definition (org_id);
CREATE INDEX workflow_step_definition_org_def_idx ON workflow_step_definition (org_id, definition_id, position);

-- ONE EXECUTION of one definition against one subject.
CREATE TABLE workflow_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  definition_id  uuid NOT NULL,
  -- The thing being processed. A run with no subject cannot say what it
  -- accomplished.
  subject_id     uuid NOT NULL,
  -- A CACHED AGGREGATE over the step rows, and the same bargain 0009 strikes for
  -- `contract_obligation.state`: stored because "where is this request" must be
  -- one indexed read, and made honest by a DEFERRED trigger that re-derives it
  -- at COMMIT and refuses any transaction leaving the two disagreeing.
  status         workflow_run_status NOT NULL DEFAULT 'running',
  started_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_run_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES workflow_definition (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_run_subject_check CHECK (subject_id IS NOT NULL),
  -- A terminal status carries a completion instant and a running one does not.
  -- Otherwise "when did this finish" has two answers for a finished run.
  CONSTRAINT workflow_run_completion_check CHECK (
        (status IN ('completed', 'declined', 'failed') AND completed_at IS NOT NULL)
     OR (status = 'running' AND completed_at IS NULL)
      ),
  CONSTRAINT workflow_run_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_run_org_idx           ON workflow_run (org_id);
CREATE INDEX workflow_run_org_def_idx       ON workflow_run (org_id, definition_id);
CREATE INDEX workflow_run_org_subject_idx   ON workflow_run (org_id, subject_id);
CREATE INDEX workflow_run_org_status_idx    ON workflow_run (org_id, status);

COMMENT ON TABLE workflow_run IS
  'One execution of a workflow definition against one subject. `status` is a CACHED AGGREGATE over workflow_step_run, constrained to equal its derivation at COMMIT by assert_workflow_run_consistent — stored for one indexed read, made honest by a trigger, and therefore unable to drift.';

-- THE DURABLE FACT OF RESUMABILITY.
--
-- `started_at` is written once and never moved. That single fact is what makes
-- a RESUME distinguishable from a RESTART: after an incident, "has this step
-- been running for four hours or did something just retry it" is answerable, and
-- it is the question an operator actually asks.
CREATE TABLE workflow_step_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL,
  definition_step_id uuid NOT NULL,
  status            workflow_step_status NOT NULL DEFAULT 'pending',
  started_at        timestamptz,
  completed_at      timestamptz,
  -- Derived from (run_id, idempotency_scope), length-framed, by the function
  -- below. STORED as well as derived, because a token a downstream system
  -- deduped on has to be re-verifiable from the row alone years later.
  retry_token       varchar(64) NOT NULL,
  outcome_kind      step_outcome_kind,
  outcome_reason    varchar(400),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_run_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES workflow_run (org_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_step_run_step_fk
    FOREIGN KEY (org_id, definition_step_id) REFERENCES workflow_step_definition (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_step_run_step_key UNIQUE (org_id, run_id, definition_step_id),
  CONSTRAINT workflow_step_run_token_key UNIQUE (org_id, retry_token),
  -- The lifecycle each status permits, in one CHECK. A `pending` row with a
  -- completed_at is a record that claims work finished before anyone began it.
  CONSTRAINT workflow_step_run_timing_check CHECK (
        (status = 'pending'    AND started_at IS NULL     AND completed_at IS NULL)
     OR (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL)
     OR (status IN ('completed', 'failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
      ),
  CONSTRAINT workflow_step_run_outcome_check CHECK (
        (outcome_kind IS NULL AND outcome_reason IS NULL)
     OR (outcome_kind IN ('succeeded') AND outcome_reason IS NULL)
     OR (outcome_kind IN ('declined', 'failed') AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '')
      ),
  CONSTRAINT workflow_step_run_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_step_run_org_idx      ON workflow_step_run (org_id);
CREATE INDEX workflow_step_run_org_run_idx   ON workflow_step_run (org_id, run_id);
CREATE INDEX workflow_step_run_org_time_idx  ON workflow_step_run (org_id, started_at);

-- The composite key a task's origin is checked against. Declared HERE rather
-- than inline in `workflow_step_run` because `task` is created earlier in this
-- file and cannot be given a forward reference; the alternative — creating
-- `task` after this table — would reorder the whole domain for one constraint.
ALTER TABLE workflow_step_run
  ADD CONSTRAINT workflow_step_run_run_step_key UNIQUE (org_id, run_id, definition_step_id);

-- THE TASK→STEP LINK IS A FOREIGN KEY, not merely a pair of columns.
--
-- A task naming a (run, step) that does not exist is a task with no traceable
-- origin, and the composite form means the step row must be in THIS
-- organisation's run — so a cross-tenant origin is structurally impossible
-- rather than merely discouraged (ADR-0011).
--
-- DEFERRABLE INITIALLY DEFERRED, because the legal order in a real workflow is
-- the REVERSE of the obvious one: the step is started, then the task is created
-- naming it. An immediate constraint would refuse the task until the step row
-- committed, which for a single transaction containing both is impossible.
ALTER TABLE task
  ADD CONSTRAINT task_origin_fk
  FOREIGN KEY (org_id, origin_run_id, origin_step_id)
  REFERENCES workflow_step_run (org_id, run_id, definition_step_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE workflow_step_run IS
  'One step''s durable state within one run. `started_at` is written once and never moved, which is what makes a resume distinguishable from a restart. `status = failed` is DISTINCT from completed because a step that errored ended without doing its work, and collapsing the two would let a progress figure count it.';

-- THE RETRY TOKEN.
--
-- sha-256 over (run_id, idempotency_scope), separated by `|`, via the BUILT-IN
-- `sha256(bytea)` function.
--
-- `digest()` from pgcrypto is NOT used, and that is an environment fact rather
-- than a preference: 0001 already records that the PGlite build ships a subset
-- of contrib, and this one does not carry pgcrypto. `sha256(bytea)` is core
-- PostgreSQL 14+ and yields the same digest, so the token is identical on every
-- target.
--
-- The `|` separator stands in for the length-framed form `packages/core` uses in
-- `contracts/version.ts`, and the gap is closed structurally rather than
-- lexically: `p_run_id` is a uuid and can never contain `|`, so no pair of
-- distinct inputs can produce one token. That argument is recorded because a
-- reader comparing this function with `contracts/version.ts` will notice the
-- difference and should find it already answered.
--
-- SECURITY DEFINER because it reads `workflow_step_definition` and the trigger
-- that calls it runs as its invoker.
CREATE OR REPLACE FUNCTION public.workflow_retry_token(p_org_id uuid, p_run_id uuid, p_step_definition_id uuid)
RETURNS varchar
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT encode(
           sha256(convert_to(p_run_id::text || '|' || s.idempotency_scope, 'UTF8')),
           'hex'
         )
    FROM public.workflow_step_definition s
   WHERE s.org_id = p_org_id
     AND s.id     = p_step_definition_id
$$;

COMMENT ON FUNCTION public.workflow_retry_token(uuid, uuid, uuid) IS
  'The retry token for one step of one run: sha-256 over the run id and the step''s idempotency scope. Stored on workflow_step_run so a token a downstream system deduped on is re-verifiable from the row alone. Returns NULL when the step is not part of the named organisation.';

-- -----------------------------------------------------------------------------
-- TRAVEL
-- -----------------------------------------------------------------------------

CREATE TABLE trip (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- THE ENGAGEMENT a guardian consents to.
  --
  -- Not nullable and not defaulted. 0008 established that consent is to an
  -- ENGAGEMENT and never a global flag — "this person's guardian said yes at
  -- some point" is not "this person's guardian said yes to THIS trip" — so a
  -- trip with no engagement could never carry a valid consent, and the column is
  -- required rather than optional to make that unexpressible.
  engagement_id   uuid NOT NULL,
  title           varchar(200) NOT NULL,
  status          trip_status NOT NULL DEFAULT 'draft',
  purpose         text,
  -- WHEN the trip BEGINS. The event date, not `created_at`: a trip booked in
  -- March for June belongs to June in every report (ADR-0019 rule 5).
  departs_at      timestamptz NOT NULL,
  returns_at      timestamptz NOT NULL,
  -- REAL SPEND, in the column types ADR-0003 governs. A trip's cost is real
  -- money that leaves the organisation, and ADR-0005's `travel` audit class
  -- exists because the legacy system had both the minors and the spend
  -- untracked.
  budget_amount   numeric(18,4),
  budget_currency varchar(3),
  actual_amount   numeric(18,4),
  actual_currency varchar(3),
  created_by      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT trip_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT trip_window_check CHECK (returns_at > departs_at),
  -- Composite FK to 0001's engagement, so a trip cannot be attached to another
  -- organisation's engagement — and therefore cannot carry another
  -- organisation's guardian consent (ADR-0011).
  CONSTRAINT trip_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  -- Both columns of a money pair or neither. A budget with no currency is a
  -- number whose unit nobody stated.
  --
  -- THE `IS NOT NULL` ON THE CURRENCY IS LOAD-BEARING, and it was found by a test
  -- rather than by reading. Written as
  --     (budget_amount IS NOT NULL AND budget_currency ~ '^[A-Z]{3}$')
  -- this CHECK PASSES for a row with an amount and a NULL currency, because
  -- `NULL ~ '...'` is NULL and a CHECK constraint rejects only an explicit FALSE
  -- — a three-valued-logic hole through which "500.0000 in no currency at all"
  -- walks straight in. `IS NOT NULL AND` closes it: a NULL currency now makes
  -- the whole conjunction FALSE rather than UNKNOWN.
  --
  -- This is the same class of bug as the `trip_traveller` consent check that was
  -- removed for a related reason, and the rule generalises: **a CHECK that can
  -- evaluate to NULL is not enforcing anything.** Every money-pair CHECK in this
  -- file is written to be total.
  CONSTRAINT trip_budget_money_check CHECK (
        (budget_amount IS NULL AND budget_currency IS NULL)
     OR (budget_amount IS NOT NULL AND budget_currency IS NOT NULL AND budget_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_actual_money_check CHECK (
        (actual_amount IS NULL AND actual_currency IS NULL)
     OR (actual_amount IS NOT NULL AND actual_currency IS NOT NULL AND actual_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_org_idx        ON trip (org_id);
CREATE INDEX trip_org_departs_idx ON trip (org_id, departs_at);
CREATE INDEX trip_org_status_idx  ON trip (org_id, status);

COMMENT ON TABLE trip IS
  'A journey with legs, travellers and destinations. `departs_at` is the EVENT date every travel report filters on, never created_at (ADR-0019 rule 5). Budget and actual spend are numeric(18,4) with an ISO 4217 currency beside them (ADR-0003); ADR-0005''s `travel` audit class exists because the legacy system tracked neither this spend nor the minors travelling.';

CREATE TABLE trip_destination (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id      uuid NOT NULL,
  -- WHERE. Free text rather than a reference table: the set of places an esports
  -- organisation travels to is not a closed vocabulary, and inventing one would
  -- make a genuinely new venue unrepresentable.
  place        varchar(200) NOT NULL,
  country_code char(2),
  -- Arrival order within the trip, explicit for the same reason step position is.
  position     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_destination_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_destination_place_check CHECK (btrim(place) <> ''),
  CONSTRAINT trip_destination_position_key UNIQUE (org_id, trip_id, position),
  CONSTRAINT trip_destination_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_destination_org_idx     ON trip_destination (org_id);
CREATE INDEX trip_destination_org_trip_idx ON trip_destination (org_id, trip_id, position);

-- A leg. Real spend per leg, so "which leg cost the most" is answerable rather
-- than inferred from a trip-level total.
CREATE TABLE trip_leg (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id          uuid NOT NULL,
  from_destination_id uuid NOT NULL,
  to_destination_id   uuid NOT NULL,
  position         integer NOT NULL,
  -- INSTANTS, not a date: a leg that departs at 02:00 on the 3rd and arrives at
  -- 06:00 on the 4th is a fact about two moments.
  departs_at       timestamptz NOT NULL,
  arrives_at       timestamptz NOT NULL,
  cost_amount      numeric(18,4),
  cost_currency    varchar(3),
  carrier          varchar(120),
  confirmation_ref varchar(120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_leg_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_leg_from_destination_fk
    FOREIGN KEY (org_id, from_destination_id) REFERENCES trip_destination (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT trip_leg_to_destination_fk
    FOREIGN KEY (org_id, to_destination_id) REFERENCES trip_destination (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT trip_leg_position_key UNIQUE (org_id, trip_id, position),
  -- A leg arriving before it departs, or from where it arrives to, is either a
  -- typo or a lie, and both make "when was this trip" unanswerable.
  CONSTRAINT trip_leg_window_check CHECK (arrives_at > departs_at),
  CONSTRAINT trip_leg_distinct_destination_check CHECK (from_destination_id <> to_destination_id),
  -- `IS NOT NULL` on the currency for the three-valued-logic reason spelled out
  -- at `trip_budget_money_check`: `NULL ~ '^[A-Z]{3}$'` is NULL, and a CHECK
  -- rejects only an explicit FALSE.
  CONSTRAINT trip_leg_money_check CHECK (
        (cost_amount IS NULL AND cost_currency IS NULL)
     OR (cost_amount IS NOT NULL AND cost_currency IS NOT NULL AND cost_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_leg_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_leg_org_idx     ON trip_leg (org_id);
CREATE INDEX trip_leg_org_trip_idx ON trip_leg (org_id, trip_id, position);
CREATE INDEX trip_leg_org_time_idx ON trip_leg (org_id, departs_at);

-- WHO IS GOING, AND — FOR A MINOR — WHO CONSENTED.
--
-- `guardian_consent_id` is the WHOLE of the guardian link in storage. It is a
-- composite FK to 0008's `guardian_consent`, so a consent from another
-- organisation cannot be attached (ADR-0011), and the guard below checks that
-- the consent actually COVERS this trip — that it names this engagement, is not
-- withdrawn, and has not expired.
--
-- NO `is_minor` COLUMN. A stored minority flag is wrong the moment a date of
-- birth is corrected, and wrong SILENTLY; `majority_at_departure` is derived by
-- a trigger from `person.birth_date` using 0008's `majority_status`, so a
-- corrected birth date corrects it everywhere at once.
CREATE TABLE trip_traveller (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id                uuid NOT NULL,
  -- Single-column: `person` is org-independent (ADR-0018).
  person_id              uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role                   traveller_role NOT NULL,
  -- DERIVED by trigger from person.birth_date, never written by a caller.
  --
  -- NOT NULL is safe here and NOT safe on the consent requirement, and the
  -- difference is worth stating: `guard_trip_traveller_consent` is a BEFORE
  -- INSERT trigger, so it has ALWAYS run by the time this column's NOT NULL is
  -- evaluated. It always sets a value — 'minor', 'adult' or 'unknown' — so NOT
  -- NULL cannot fire spuriously, and it makes "a traveller whose majority was
  -- never derived" unrepresentable rather than merely unlikely.
  majority_at_departure  text NOT NULL,
  -- Null for an adult. Required by the guard below for a KNOWN minor — which is
  -- the whole point of the table.
  guardian_consent_id    uuid,
  -- Free-text emergency and medical detail, deliberately NOT modelled as
  -- columns: the shape varies by jurisdiction and by traveller, and a fixed
  -- schema would be a guess dressed as a standard. The audit trail is the row.
  emergency_contact      text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_traveller_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_traveller_consent_fk
    FOREIGN KEY (org_id, guardian_consent_id) REFERENCES guardian_consent (org_id, id) ON DELETE RESTRICT,
  -- One traveller per person per trip. Two rows would mean the traveller is
  -- going twice, which is either a duplicate or a lie about capacity.
  CONSTRAINT trip_traveller_person_key UNIQUE (org_id, trip_id, person_id),
  --
  -- NO "a minor needs a consent" CHECK HERE, and the absence is a correction.
  --
  -- An earlier draft put it here as a CHECK on `majority_at_departure`, which
  -- does not work and fails OPEN — the worst possible direction. PostgreSQL
  -- evaluates a CHECK against the row as it stands when the statement runs, and
  -- `majority_at_departure` is NULL at that moment because it is filled in by a
  -- BEFORE INSERT trigger that fires afterwards. So `NULL IS DISTINCT FROM
  -- 'minor'` was TRUE, every minor was admitted with no consent, and the check
  -- silently protected nobody.
  --
  -- The rule therefore lives in `guard_trip_traveller_consent` below, which is
  -- guaranteed to run BEFORE the row is checked and which computes majority
  -- itself. A constraint that cannot see the value it is constraining is not a
  -- constraint.
  -- A known minor needs a live consent; an adult does not, and neither does a
  -- person whose birth date nobody recorded — `unknown` means UNKNOWN and never
  -- means adult, and 0008's reasoning applies unchanged: refusing every traveller
  -- whose birth date is missing would be a decision this schema has no basis for.
  -- The residual gap (an unknown-age traveller with no consent) is a gap in the
  -- DATA, not in the constraint, and is named in the file header rather than
  -- hidden.
  CONSTRAINT trip_traveller_majority_check CHECK (
        majority_at_departure IN ('minor', 'adult', 'unknown')
      ),
  CONSTRAINT trip_traveller_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_traveller_org_idx       ON trip_traveller (org_id);
CREATE INDEX trip_traveller_org_trip_idx  ON trip_traveller (org_id, trip_id);
CREATE INDEX trip_traveller_org_person_idx ON trip_traveller (org_id, person_id);

COMMENT ON TABLE trip_traveller IS
  'One person travelling on one trip. `majority_at_departure` is DERIVED by trigger from person.birth_date through 0008''s majority_status() — there is no stored is_minor flag anywhere, because a stored flag is wrong the moment a birth date is corrected and wrong silently. A KNOWN minor REQUIRES a guardian_consent_id, and the guard below additionally requires that consent to COVER this trip, be un-withdrawn and unexpired.';

-- -----------------------------------------------------------------------------
-- ASSETS
-- -----------------------------------------------------------------------------

-- WHAT A THING IS. There is NO `holder_id` column anywhere in this file, and
-- that absence is the design.
--
-- ADR-0016 found the legacy system could not say where a thing was. The fix it
-- implies is structural rather than procedural: a mutable holder column records
-- the CURRENT holder and destroys every previous one, so "who had this in March"
-- becomes unanswerable the moment the column is updated. `asset_custody` is
-- append-only and `asset_holder_at` DERIVES the answer, exactly as
-- `inventory_position` derives a stock balance in 0009 and for the same reason.
CREATE TABLE asset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Tagged. A barcode or asset tag, which is how the thing is found in a room.
  asset_tag       varchar(64) NOT NULL,
  name            varchar(200) NOT NULL,
  category        varchar(60) NOT NULL,
  serial_number   varchar(120),
  -- Free text rather than a FK to a purchase: the provenance of a laptop lives
  -- in a procurement system this schema does not model, and a dangling FK is a
  -- worse answer than an honest reference.
  purchased_at    timestamptz,
  purchase_amount numeric(18,4),
  purchase_currency varchar(3),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT asset_tag_check CHECK (btrim(asset_tag) <> ''),
  CONSTRAINT asset_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT asset_category_check CHECK (category ~ '^[a-z][a-z0-9_]*$'),
  -- `IS NOT NULL` on the currency: see `trip_budget_money_check` for why a CHECK
  -- that can evaluate to NULL enforces nothing.
  CONSTRAINT asset_purchase_money_check CHECK (
        (purchase_amount IS NULL AND purchase_currency IS NULL)
     OR (purchase_amount IS NOT NULL AND purchase_currency IS NOT NULL AND purchase_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT asset_org_tag_key UNIQUE (org_id, asset_tag),
  CONSTRAINT asset_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX asset_org_idx       ON asset (org_id);
CREATE INDEX asset_org_category_idx ON asset (org_id, category);

COMMENT ON TABLE asset IS
  'A trackable thing. There is deliberately NO holder column: custody is an append-only record and the current holder is DERIVED, because a mutable holder_id overwrites every previous holder and makes "where was this last March" unanswerable — precisely the gap ADR-0016 found in the legacy system.';

-- WHO HELD IT, WHEN. Strictly append-only, no `archived_at` because UPDATE is
-- impossible (0004's rule).
--
-- A custody record either ASSIGNS the asset (`to_person_id` set, `from_person_id`
-- null — the first issue) or TRANSFERS it (both set — a hand-over). That
-- distinction is a CHECK rather than a convention because "who returned it and
-- to whom" is the question the table exists to answer.
CREATE TABLE asset_custody (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL,
  kind           custody_kind NOT NULL,
  -- Null on the FIRST issue only.
  from_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  to_person_id   uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN the custody changed, not when the row was written.
  occurred_at    timestamptz NOT NULL,
  -- A loss or disposal ends custody with nobody holding it; an issue or transfer
  -- ends with somebody holding it.
  condition_note text,
  reason         varchar(400),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_custody_asset_fk
    FOREIGN KEY (org_id, asset_id) REFERENCES asset (org_id, id) ON DELETE CASCADE,
  -- The shape each kind is allowed. The reading is about WHERE THE ASSET GOES,
  -- and it is the thing that makes the derived holder correct:
  --
  --   issue    from = the stockroom (NULL), to = the person. The FIRST event.
  --   return   from = the person,   to = the stockroom (NULL). The LAST event,
  --            and `to_person_id IS NULL` is exactly what makes
  --            `asset_holder_at` answer "nobody" afterwards rather than naming
  --            whoever last had it.
  --   transfer from = the person,   to = the next person. A hand-over.
  --   loss / disposal   to = NULL. It is with nobody, which is a real state and
  --            the one `asset_holder_at` reports as NULL.
  --
  -- So `to_person_id IS NULL` is REQUIRED for return/loss/disposal, not merely
  -- permitted for it. An earlier draft of this file allowed a `return` to name a
  -- recipient, and every return then left the asset looking held by them — which
  -- is the "where was this" answer being wrong in the direction that hides a
  -- missing item.
  CONSTRAINT asset_custody_shape_check CHECK (
        (kind = 'issue'                 AND from_person_id IS NULL     AND to_person_id IS NOT NULL)
     OR (kind IN ('return', 'transfer') AND from_person_id IS NOT NULL AND to_person_id IS NOT NULL)
     OR (kind IN ('loss', 'disposal')    AND to_person_id IS NULL)
      ),
  -- The asset cannot be handed to the person returning it. That is not an
  -- unusual hand-over; it is nobody handing over.
  CONSTRAINT asset_custody_distinct_people_check CHECK (
        to_person_id IS NULL OR from_person_id IS NULL OR to_person_id <> from_person_id
      ),
  CONSTRAINT asset_custody_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX asset_custody_org_idx       ON asset_custody (org_id);
CREATE INDEX asset_custody_org_asset_idx ON asset_custody (org_id, asset_id, occurred_at);
CREATE INDEX asset_custody_org_to_idx    ON asset_custody (org_id, to_person_id);
CREATE INDEX asset_custody_org_from_idx  ON asset_custody (org_id, from_person_id);

COMMENT ON TABLE asset_custody IS
  'One append-only custody record: who held the asset, from when, and what changed. NOT a mutable holder column. Two events may not share an instant for one asset — that ambiguity is refused below — so "who held this at 14:00" has exactly one answer.';

-- -----------------------------------------------------------------------------
-- FACILITIES
-- -----------------------------------------------------------------------------

CREATE TABLE facility (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name           varchar(200) NOT NULL,
  -- Bookable or not: a server room that nobody may book is a fact worth
  -- recording, and encoding it as a row rather than as its absence from the book
  -- means "why can I not book this" has an answer.
  bookable       boolean NOT NULL DEFAULT true,
  -- Concurrent capacity. 1 for a room; more for a booth bank. NULL for
  -- unbounded, which is a different claim from 1 and not the same default.
  capacity       integer,
  time_zone      varchar(64) NOT NULL DEFAULT 'UTC',
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT facility_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT facility_capacity_check CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT facility_org_name_key UNIQUE (org_id, name),
  CONSTRAINT facility_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX facility_org_idx ON facility (org_id);

COMMENT ON TABLE facility IS
  'A bookable resource. `capacity` is NULL for unbounded, which is a DIFFERENT claim from 1 — a room holds one booking and a booth bank holds several, and defaulting one to the other silently loses bookings.';

CREATE TABLE facility_reservation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  facility_id       uuid NOT NULL,
  purpose           varchar(200) NOT NULL,
  state             facility_reservation_state NOT NULL DEFAULT 'confirmed',
  -- HALF-OPEN [starts_at, ends_at), the same convention `inventory_item` uses for
  -- effective dating. A 09:00–10:00 booking and a 10:00–11:00 booking therefore
  -- do NOT overlap, which is what makes back-to-back scheduling possible at all.
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  requested_by      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_reservation_facility_fk
    FOREIGN KEY (org_id, facility_id) REFERENCES facility (org_id, id) ON DELETE CASCADE,
  CONSTRAINT facility_reservation_window_check CHECK (ends_at > starts_at),
  CONSTRAINT facility_reservation_purpose_check CHECK (btrim(purpose) <> ''),
  CONSTRAINT facility_reservation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX facility_reservation_org_idx       ON facility_reservation (org_id);
CREATE INDEX facility_reservation_org_facility_idx ON facility_reservation (org_id, facility_id, starts_at);
CREATE INDEX facility_reservation_org_time_idx  ON facility_reservation (org_id, starts_at);

COMMENT ON TABLE facility_reservation IS
  'One booking of one facility, half-open [starts_at, ends_at) so back-to-back bookings are legal. Overlap is refused by a DEFERRABLE CONSTRAINT TRIGGER, judged at COMMIT so a batch of bookings is judged as a batch — an IMMEDIATE check would reject a batch that fits and admit one that does not, depending only on the order the rows arrived in.';

-- =============================================================================
-- GUARDS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- THE TASK TRANSITION GUARD
-- -----------------------------------------------------------------------------
--
-- BEFORE UPDATE OF state, so the row never exists in a state the database would
-- refuse. Immediate rather than deferred: the ordering is not circular — a
-- transition is written AFTER the state change it records — so deferring would
-- buy nothing and would let an illegal state be visible to the transaction that
-- created it.
CREATE OR REPLACE FUNCTION public.guard_task_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.task_state_transition t
            WHERE t.org_id     = NEW.org_id
              AND t.from_state = OLD.state
              AND t.to_state   = NEW.state
         )
    INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'task % cannot move from % to %: that transition is not in this organisation''s task_state_transition table.',
      NEW.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_task_transition() IS
  'Refuses a task state change whose edge is absent from task_state_transition. Fires BEFORE UPDATE, so the row never exists in the refused state. An organisation whose transition table is empty refuses every move rather than accepting every one.';

REVOKE ALL ON FUNCTION public.guard_task_transition() FROM PUBLIC;

CREATE TRIGGER task_transition_is_declared
  BEFORE UPDATE OF state ON task
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_transition();

-- -----------------------------------------------------------------------------
-- THE WORKFLOW RUN STATUS GUARD — THE CACHED AGGREGATE CANNOT DRIFT
-- -----------------------------------------------------------------------------
--
-- The definition of a run's status, written ONCE. `workflow_run.status` is the
-- cached aggregate a screen reads; this is the derivation; and the trigger below
-- refuses any COMMIT that leaves them disagreeing.
--
--   failed     any step failed. Terminal — the next step is not pending, it is
--              blocked on a decision the caller has not made.
--   declined   the LAST step declined, and none failed.
--   completed  every step is `completed`, and none failed.
--   running    anything else, including a run where an earlier step declined and
--              later steps still apply.
CREATE OR REPLACE FUNCTION public.workflow_derived_status_in_org(p_org_id uuid, p_run_id uuid)
RETURNS workflow_run_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH counts AS (
    SELECT count(*)::integer                                                        AS total,
           count(*) FILTER (WHERE s.status = 'completed')::integer                   AS completed,
           count(*) FILTER (WHERE s.status = 'failed')::integer                      AS failed,
           count(*) FILTER (WHERE s.status = 'completed' AND s.outcome_kind = 'declined')::integer AS declined
      FROM public.workflow_step_run s
     WHERE s.org_id = p_org_id
       AND s.run_id = p_run_id
  )
  SELECT CASE
           WHEN c.failed > 0                             THEN 'failed'::public.workflow_run_status
           WHEN c.total > 0 AND c.completed = c.total
             THEN CASE WHEN c.declined = c.total
                        THEN 'declined'::public.workflow_run_status
                        ELSE 'completed'::public.workflow_run_status
                      END
           ELSE 'running'::public.workflow_run_status
         END
    FROM counts c
$$;

COMMENT ON FUNCTION public.workflow_derived_status_in_org(uuid, uuid) IS
  'The aggregate status of one run in one organisation, recomputed from its step rows. THE SINGLE DEFINITION: workflow_run.status is constrained to equal it at COMMIT. A run with no steps is ''running'', never ''completed'' — an execution that did nothing is not a finished one.';

CREATE OR REPLACE FUNCTION public.assert_workflow_run_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id   uuid;
  v_run_id   uuid;
  v_stored   public.workflow_run_status;
  v_derived  public.workflow_run_status;
BEGIN
  IF TG_TABLE_NAME = 'workflow_run' THEN
    v_org_id := NEW.org_id;
    v_run_id := NEW.id;
  ELSE
    v_org_id := NEW.org_id;
    v_run_id := NEW.run_id;
  END IF;

  SELECT r.status INTO v_stored
    FROM public.workflow_run r
   WHERE r.org_id = v_org_id
     AND r.id     = v_run_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_derived := public.workflow_derived_status_in_org(v_org_id, v_run_id);

  IF v_stored IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION
      'workflow run % stores status ''%'' but its % step row(s) aggregate to ''%''. Move the status to ''%'' in this same transaction.',
      v_run_id, v_stored, v_derived, v_derived, v_derived
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_workflow_run_consistent() IS
  'Re-derives a run''s status from its step rows at COMMIT and refuses any transaction that leaves workflow_run.status disagreeing. Deferred, so "complete the step AND move the run" is one transaction — the same shape 0004 uses for a ledger reversal and 0009 uses for an obligation discharge.';

REVOKE ALL ON FUNCTION public.assert_workflow_run_consistent() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER workflow_run_status_is_derived
  AFTER INSERT OR UPDATE ON workflow_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

CREATE CONSTRAINT TRIGGER workflow_step_run_rejustifies_parent
  AFTER INSERT OR UPDATE ON workflow_step_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

-- The same judgement, on the OTHER side of the same disagreement.
--
-- `assert_workflow_run_consistent` catches "the steps say finished and the run
-- does not". This catches "the run says finished and a step does not" — which the
-- first cannot see, because a run updated on its own fires only the run's own
-- trigger and re-derives from steps that have not moved.
--
-- Without it the asymmetry is a hole: a caller could `UPDATE workflow_run SET
-- status='completed'` alone and the deferred check would derive `running` from
-- the untouched steps and refuse — so the hole is closed by the OTHER trigger,
-- but only for that direction. The honest fix is to check the run's status
-- against its steps from BOTH sides, and this is the missing side.
CREATE CONSTRAINT TRIGGER workflow_run_agrees_with_its_steps
  AFTER INSERT OR UPDATE OF status ON workflow_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

-- And the task/step agreement, fired from the STEP side as well as the task side.
-- `assert_task_matches_its_step` is attached to `task`, so it sees a task change
-- but not a step change. Attaching it to `workflow_step_run` closes that: a step
-- completing while its task is still open is exactly the disagreement, and the
-- task-side trigger cannot observe it because the task did not move.
CREATE OR REPLACE FUNCTION public.assert_step_matches_its_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task_id    uuid;
  v_task_state public.task_state;
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT t.id, t.state INTO v_task_id, v_task_state
    FROM public.task t
   WHERE t.org_id         = NEW.org_id
     AND t.origin_run_id  = NEW.run_id
     AND t.origin_step_id = NEW.definition_step_id;

  IF NOT FOUND THEN
    -- No task was created by this step. Not every step creates one, so this is
    -- the normal case rather than a gap.
    RETURN NULL;
  END IF;

  IF v_task_state NOT IN ('done', 'cancelled') THEN
    RAISE EXCEPTION
      'workflow step % of run % is complete but the task it created (%) is ''%''. The run and the backlog disagree, and one of them is lying.',
      NEW.definition_step_id, NEW.run_id, v_task_id, v_task_state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_step_matches_its_task() IS
  'The step-side half of the task/workflow agreement. assert_task_matches_its_step fires on the TASK, so it cannot observe a step completing under a task that did not move; this fires on the STEP and closes that direction. A step that created no task passes, because not every step creates one.';

REVOKE ALL ON FUNCTION public.assert_step_matches_its_task() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER workflow_step_agrees_with_its_task
  AFTER INSERT OR UPDATE OF status ON workflow_step_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_step_matches_its_task();

-- -----------------------------------------------------------------------------
-- THE TASK AND WORKFLOW STATE MUST AGREE
-- -----------------------------------------------------------------------------
--
-- A task a workflow step created carries `origin_run_id` / `origin_step_id`, and
-- a completed step whose task is not `done` means the run and the backlog
-- disagree. `assert_task_matches_its_step` refuses the disagreement at COMMIT,
-- for the same reason the run status is checked: two records of the same fact
-- that can drift apart is the defect, not the feature.
--
-- DEFERRABLE because the legal order is "the task is created, then the step
-- completes", and an IMMEDIATE trigger would refuse the step completion before
-- the task update could be written.
CREATE OR REPLACE FUNCTION public.assert_task_matches_its_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task_id uuid;
  v_org_id  uuid;
  v_status  public.workflow_step_status;
BEGIN
  IF TG_TABLE_NAME = 'task' THEN
    v_task_id := NEW.id;
    v_org_id  := NEW.org_id;
  ELSE
    RETURN NULL;
  END IF;

  IF NEW.origin_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.status INTO v_status
    FROM public.workflow_step_run s
   WHERE s.org_id = NEW.org_id
     AND s.run_id = NEW.origin_run_id
     AND s.definition_step_id = NEW.origin_step_id;

  -- The step row does not exist yet, which is the normal order: a step is started
  -- before the task it creates. Nothing to judge.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_status = 'completed' AND NEW.state NOT IN ('done', 'cancelled') THEN
    RAISE EXCEPTION
      'workflow step % of run % is complete but its task % is ''%''. The run and the backlog disagree, and one of them is lying.',
      NEW.origin_step_id, NEW.origin_run_id, v_task_id, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_task_matches_its_step() IS
  'Refuses a COMMIT in which a workflow step is complete while the task it created is neither done nor cancelled. Deferred, so "finish the step AND finish the task" is one transaction.';

REVOKE ALL ON FUNCTION public.assert_task_matches_its_step() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER task_agrees_with_its_workflow_step
  AFTER INSERT OR UPDATE OF state ON task
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_task_matches_its_step();

-- -----------------------------------------------------------------------------
-- THE MINOR TRAVELLER GUARD — GUARDIAN CONSENT, REUSED NOT RESTATED
-- -----------------------------------------------------------------------------
--
-- BEFORE INSERT OR UPDATE, so a row never exists in a state that would be
-- refused. It does two things and NOTHING else:
--
--   1. Derives `majority_at_departure` from `person.birth_date` through 0008's
--      `majority_status`, so there is no stored minority flag anywhere.
--   2. For a KNOWN minor, requires that the named `guardian_consent_id` actually
--      COVERS this trip — names this engagement, is not withdrawn, and has not
--      expired at the departure instant.
--
-- The rules themselves are 0008's `guardian_consent_covers_in_org` and
-- `packages/core/src/minors`. Nothing about majority, consent or the engagement
-- floor is restated here; a second copy is how two parts of a product come to
-- disagree about who is a child, which is exactly what 0008's single-threshold
-- comment exists to prevent.
CREATE OR REPLACE FUNCTION public.guard_trip_traveller_consent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_departs    timestamptz;
  v_engagement uuid;
  v_birth      date;
  v_majority   text;
  v_covers     boolean;
BEGIN
  SELECT t.departs_at, t.engagement_id INTO v_departs, v_engagement
    FROM public.trip t
   WHERE t.org_id = NEW.org_id
     AND t.id     = NEW.trip_id;

  IF v_departs IS NULL THEN
    RAISE EXCEPTION
      'trip_traveller names trip %, which does not exist in organisation %.',
      NEW.trip_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT p.birth_date INTO v_birth
    FROM public.person p
   WHERE p.id = NEW.person_id;

  -- 0008's function is the ONLY definition of majority in this schema.
  v_majority := public.majority_status(v_birth, (v_departs AT TIME ZONE 'UTC')::date);
  NEW.majority_at_departure := v_majority;

  IF v_majority <> 'minor' THEN
    RETURN NEW;
  END IF;

  IF NEW.guardian_consent_id IS NULL THEN
    RAISE EXCEPTION
      'person % is a minor on % (trip %) and no guardian consent is recorded. A minor may not travel without a guardian who consented to THIS trip.',
      NEW.person_id, v_departs, NEW.trip_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0008's `guardian_consent_covers_in_org` is the ONLY definition of "this
  -- consent covers this engagement", and it takes the ENGAGEMENT — which is why
  -- `trip.engagement_id` exists and is NOT NULL. Restating the rule here would be
  -- a second copy of it drifting.
  SELECT public.guardian_consent_covers_in_org(
           NEW.org_id, NEW.person_id, v_engagement, v_departs
         )
    INTO v_covers;

  IF NOT v_covers THEN
    RAISE EXCEPTION
      'no guardian consent covers person % on engagement % departing % (trip %): the recorded consent % must name THIS engagement, be un-withdrawn and unexpired. A consent for another engagement is not a consent for this one.',
      NEW.person_id, v_engagement, v_departs, NEW.trip_id, NEW.guardian_consent_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_trip_traveller_consent() IS
  'Derives majority_at_departure from person.birth_date through 0008''s majority_status — there is no stored minority flag — and refuses a KNOWN minor travelling without a guardian consent that COVERS this trip at the departure instant. The rules are 0008''s and packages/core/src/minors''; none of them is restated here.';

REVOKE ALL ON FUNCTION public.guard_trip_traveller_consent() FROM PUBLIC;

CREATE TRIGGER trip_traveller_requires_live_guardian_consent
  BEFORE INSERT OR UPDATE OF person_id, trip_id, guardian_consent_id ON trip_traveller
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_traveller_consent();

-- -----------------------------------------------------------------------------
-- THE ASSET CUSTODY GUARD
-- -----------------------------------------------------------------------------
--
-- Two events may not share an instant for one asset, and a transfer must name the
-- person who actually held it.
--
-- The first is what makes "who held this at 14:00" have exactly ONE answer. Two
-- rows at the same instant make it answerable two ways, and a custody history is
-- worthless the moment it has two answers to its central question.
--
-- The second is the integrity that matters day to day: a hand-over FROM somebody
-- who does not hold the thing is a custody record that will not reconcile with
-- the row before it.
CREATE OR REPLACE FUNCTION public.guard_asset_custody()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_conflict   uuid;
  v_previous   record;
BEGIN
  -- 1. One event per instant per asset.
  SELECT c.id INTO v_conflict
    FROM public.asset_custody c
   WHERE c.org_id    = NEW.org_id
     AND c.asset_id  = NEW.asset_id
     AND c.occurred_at = NEW.occurred_at
     AND c.id <> NEW.id
   LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'asset % already has a custody event at % (record %). "Who held this then" must have exactly one answer.',
      NEW.asset_id, NEW.occurred_at, v_conflict
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. A transfer names the person who actually held it.
  IF NEW.kind = 'transfer' THEN
    SELECT c.to_person_id INTO v_previous
      FROM public.asset_custody c
     WHERE c.org_id     = NEW.org_id
       AND c.asset_id   = NEW.asset_id
       AND c.occurred_at < NEW.occurred_at
     ORDER BY c.occurred_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'asset % cannot be transferred at %: it has no custody history, so it has never been issued.',
        NEW.asset_id, NEW.occurred_at
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_previous.to_person_id IS DISTINCT FROM NEW.from_person_id THEN
      RAISE EXCEPTION
        'asset % is recorded as held by % at the moment before this transfer, but the transfer names % as the sender. A custody history that does not reconcile with itself is not a history.',
        NEW.asset_id, v_previous.to_person_id, NEW.from_person_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_asset_custody() IS
  'Refuses two custody events for one asset at one instant — which would make "who held this then" answerable two ways — and refuses a transfer naming a sender who does not hold the asset. The second check is what keeps the derived holder consistent with the rows above it.';

REVOKE ALL ON FUNCTION public.guard_asset_custody() FROM PUBLIC;

CREATE TRIGGER asset_custody_is_unambiguous
  BEFORE INSERT OR UPDATE ON asset_custody
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_custody();

-- WHO HELD IT, AT AN INSTANT. The derivation, answering the question the legacy
-- system could not.
--
-- Half-open [occurred_at, …), so an event AT the queried instant has already
-- happened. "Who held this at 10:00" with an event logged at 10:00 should answer
-- with the 10:00 holder, not the one before it.
CREATE OR REPLACE FUNCTION public.asset_holder_at(p_org_id uuid, p_asset_id uuid, p_at timestamptz)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.to_person_id
    FROM public.asset_custody c
   WHERE c.org_id       = p_org_id
     AND c.asset_id     = p_asset_id
     AND c.occurred_at <= p_at
   ORDER BY c.occurred_at DESC, c.id
   LIMIT 1
$$;

COMMENT ON FUNCTION public.asset_holder_at(uuid, uuid, timestamptz) IS
  'Who held an asset at an instant, DERIVED from the append-only custody record rather than stored. NULL means nobody: never issued, lost, or disposed. Takes an explicit organisation because an integrity trigger must not depend on session state (the reasoning of guardian_consent_covers_in_org in 0008).';

-- The whole custody history, answered in one query. NO LIMIT, for ADR-0019's
-- reason: a report that silently capped its result set and presented it as the
-- whole would be the defect that ADR exists to record.
CREATE OR REPLACE FUNCTION public.asset_custody_trail(p_asset_id uuid)
RETURNS TABLE (
  custody_id     uuid,
  kind           custody_kind,
  from_person_id uuid,
  to_person_id   uuid,
  occurred_at    timestamptz,
  reason         varchar(400),
  held_from      timestamptz,
  held_until     timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id,
         c.kind,
         c.from_person_id,
         c.to_person_id,
         c.occurred_at,
         c.reason,
         c.occurred_at,
         lead(c.occurred_at) OVER (PARTITION BY c.asset_id ORDER BY c.occurred_at, c.id)
    FROM public.asset_custody c
   WHERE c.org_id   = public.current_org_id()
     AND c.asset_id = p_asset_id
   ORDER BY c.occurred_at, c.id
$$;

COMMENT ON FUNCTION public.asset_custody_trail(uuid) IS
  'The full custody history of one asset in the session''s organisation, each row carrying the window during which that holder held it. Takes no organisation argument (ADR-0011 rule 3), so an unset context reads nothing. SECURITY INVOKER, and carries NO LIMIT, because a report that silently capped its result set and presented it as the whole would be the defect ADR-0019 recorded.';

-- -----------------------------------------------------------------------------
-- THE DOUBLE-BOOKING GUARD
-- -----------------------------------------------------------------------------
--
-- Overlapping reservations for one facility are impossible.
--
-- WHY A TRIGGER AND NOT `EXCLUDE USING gist`
-- ------------------------------------------
-- Both alternatives were tried and both are recorded as failures in this
-- project's environment history: `btree_gist` is UNAVAILABLE in PGlite, and
-- `EXCLUDE USING gist` over a `uuid` column FAILS because the uuid GiST operator
-- class does not exist in the build PGlite ships. So the overlap guard is a
-- plain BEFORE trigger comparing timestamps, which works everywhere.
--
-- WHY DEFERRABLE, AND JUDGED AT COMMIT
-- -----------------------------------
-- An IMMEDIATE trigger would judge each row ALONE. A batch of reservations
-- moved from `held` to `confirmed` would then reject a batch that fits and admit
-- one that does not, depending only on the order the rows arrived in — and a
-- correctness rule whose outcome depends on row order is not a correctness rule.
-- Deferring to COMMIT judges the SET, which is the thing the rule is about.
--
-- This is the same bargain 0005 and 0009 strike for a prize pool and an
-- obligation, and it is why this trigger is a CONSTRAINT trigger.
CREATE OR REPLACE FUNCTION public.guard_facility_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity  integer;
  v_live      integer;
  v_other     record;
BEGIN
  -- A cancelled reservation holds nothing and blocks nothing. Modelling that here
  -- rather than with a partial index is deliberate: the same rule then applies
  -- to an UPDATE that cancels, and there is no second path to get wrong.
  IF NEW.state = 'cancelled' THEN
    RETURN NULL;
  END IF;

  SELECT f.capacity INTO v_capacity
    FROM public.facility f
   WHERE f.org_id = NEW.org_id
     AND f.id     = NEW.facility_id;

  -- NULL capacity means UNBOUNDED, so there is nothing to overlap-check: the
  -- capacity rule below is the only one, and it permits any number. A facility
  -- that can hold any number of concurrent bookings does not "double-book" at
  -- all — treating it as capacity-1 would be inventing a constraint nobody asked
  -- for.
  IF v_capacity IS NULL THEN
    RETURN NULL;
  END IF;

  -- Count how many LIVE reservations already overlap this window. If the facility
  -- has capacity N, then N simultaneous bookings are FINE and only the (N+1)th
  -- overlapping one is a double-booking. Enforcing a hard "no two overlap ever"
  -- rule here would make a capacity-3 booth bank behave like a capacity-1 room,
  -- which is the mistake of treating "bookable" as "single occupancy".
  SELECT count(*)::integer INTO v_live
    FROM public.facility_reservation r
   WHERE r.org_id      = NEW.org_id
     AND r.facility_id = NEW.facility_id
     AND r.id <> NEW.id
     AND r.state <> 'cancelled'
     AND NEW.starts_at < r.ends_at
     AND r.starts_at < NEW.ends_at;

  IF v_live < v_capacity THEN
    -- Room remains for this one.
    RETURN NULL;
  END IF;

  -- At or over capacity: name the specific booking it clashes with so the caller
  -- is not left counting rows.
  SELECT r.id, r.starts_at, r.ends_at INTO v_other
    FROM public.facility_reservation r
   WHERE r.org_id      = NEW.org_id
     AND r.facility_id = NEW.facility_id
     AND r.id <> NEW.id
     AND r.state <> 'cancelled'
     AND NEW.starts_at < r.ends_at
     AND r.starts_at < NEW.ends_at
   LIMIT 1;

  RAISE EXCEPTION
    'facility % holds capacity % and already has % booking(s) overlapping % to %; this one (% to %) makes % , which is over capacity. Half-open windows: a booking may begin exactly when another ends, but not before.',
    NEW.facility_id, v_capacity, v_live, v_other.starts_at, v_other.ends_at, NEW.starts_at, NEW.ends_at, v_live + 1
    USING ERRCODE = 'check_violation';
END
$$;

COMMENT ON FUNCTION public.guard_facility_overlap() IS
  'Refuses a booking that would push a facility past its concurrent CAPACITY. Half-open [starts_at, ends_at): a booking may begin exactly when another ends. A capacity-1 room refuses any overlap; a capacity-5 booth bank permits five and refuses the sixth; NULL capacity is UNBOUNDED and never refuses. A cancelled reservation blocks nothing. Enforced as a DEFERRABLE CONSTRAINT TRIGGER so a batch of bookings is judged at COMMIT as a batch rather than row by row in arrival order.';

REVOKE ALL ON FUNCTION public.guard_facility_overlap() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER facility_reservations_do_not_overlap
  AFTER INSERT OR UPDATE OF starts_at, ends_at, facility_id, state ON facility_reservation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_facility_overlap();

-- -----------------------------------------------------------------------------
-- WHY THERE IS NO SECOND CAPACITY TRIGGER
-- ---------------------------------------
-- An earlier draft of this file carried a SEPARATE `assert_facility_capacity`
-- alongside the overlap guard: the first refused any two overlapping bookings,
-- the second refused any that exceeded `capacity`. Both fired on every row, and a
-- capacity-1 facility was checked twice for the same fact.
--
-- Worse, the pair was jointly WRONG. The overlap guard refused any overlap at
-- all, so a booth bank with capacity 5 behaved exactly like a room with capacity
-- 1 � three teams could not book three booths for the same scrim block. Fixing
-- that inside the overlap guard (count the live overlaps, refuse only past
-- capacity) makes the separate capacity trigger REDUNDANT: it counts precisely
-- the same rows and refuses precisely the same condition.
--
-- One rule, one trigger. A second mechanism enforcing the same fact is not
-- defence in depth, it is a second thing to get wrong.
-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- THE TOKEN IS WRITTEN, NOT SUPPLIED
-- -----------------------------------------------------------------------------
--
-- A caller-supplied retry token is a claim the database has no way to check, and
-- the whole point of storing one is that a downstream system deduped on it. So
-- the token is DERIVED on insert and a caller cannot supply one at all.
CREATE OR REPLACE FUNCTION public.derive_workflow_step_run_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.retry_token := public.workflow_retry_token(NEW.org_id, NEW.run_id, NEW.definition_step_id);

  IF NEW.retry_token IS NULL THEN
    RAISE EXCEPTION
      'workflow step definition % is not part of organisation %, so no retry token can be derived for it.',
      NEW.definition_step_id, NEW.org_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.derive_workflow_step_run_token() IS
  'Derives workflow_step_run.retry_token from the run and the step''s idempotency scope, so a caller cannot supply a token the database cannot verify. A NULL scope lookup — a step definition from another organisation — is refused rather than stored as a NULL token.';

REVOKE ALL ON FUNCTION public.derive_workflow_step_run_token() FROM PUBLIC;

CREATE TRIGGER workflow_step_run_token_is_derived
  BEFORE INSERT OR UPDATE OF run_id, definition_step_id ON workflow_step_run
  FOR EACH ROW EXECUTE FUNCTION public.derive_workflow_step_run_token();

-- =============================================================================
-- SEEDING
-- =============================================================================

-- The task state machine, seeded for a new organisation.
--
-- The edges are the same ones `packages/core/src/tasks/task.ts` declares, and
-- `tasks.operators.test.ts` asserts the two agree by name. `open -> done` is
-- ABSENT deliberately: completion is reachable only through in_review, so a
-- completed task has by construction passed a state somebody looked at.
CREATE OR REPLACE FUNCTION public.seed_task_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  edge record;
BEGIN
  FOR edge IN
    SELECT * FROM (VALUES
      ('open'::public.task_state,        'in_progress'::public.task_state),
      ('open'::public.task_state,        'blocked'::public.task_state),
      ('open'::public.task_state,        'cancelled'::public.task_state),
      ('in_progress'::public.task_state, 'blocked'::public.task_state),
      ('in_progress'::public.task_state, 'in_review'::public.task_state),
      ('in_progress'::public.task_state, 'cancelled'::public.task_state),
      ('blocked'::public.task_state,     'in_progress'::public.task_state),
      ('blocked'::public.task_state,     'cancelled'::public.task_state),
      ('in_review'::public.task_state,   'in_progress'::public.task_state),
      ('in_review'::public.task_state,   'done'::public.task_state),
      ('in_review'::public.task_state,   'cancelled'::public.task_state)
    ) AS e(from_state, to_state)
  LOOP
    INSERT INTO public.task_state_transition (org_id, from_state, to_state)
    VALUES (p_org_id, edge.from_state, edge.to_state)
    ON CONFLICT DO NOTHING;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.seed_task_state_transition(uuid) IS
  'Seeds the task state machine for a new organisation, so no organisation can exist without one and every state change is judged against a populated transition table. The edges are those packages/core/src/tasks declares; a test asserts the two agree.';

REVOKE ALL ON FUNCTION public.seed_task_state_transition(uuid) FROM PUBLIC;

-- A second AFTER INSERT trigger on `organization`, alongside 0008''s and 0009''s.
-- They coexist rather than being merged into an edit to an applied migration, and
-- all three are independently idempotent.
CREATE OR REPLACE FUNCTION public.on_organization_created_operations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_task_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created_operations() IS
  'Seeds the task state machine for a new organisation, so no organisation can exist without one.';

REVOKE ALL ON FUNCTION public.on_organization_created_operations() FROM PUBLIC;

CREATE TRIGGER organization_seeds_task_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created_operations();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

-- Identical to 0001 through 0009 and not restated in prose per table: the tenant
-- predicate is the WHOLE policy, and there is no `IS NULL` escape — an unset
-- `app.org_id` therefore matches nothing and the session fails CLOSED rather
-- than reading every tenant (ADR-0015).
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'task','task_state_transition','task_dependency','task_transition',
    'workflow_definition','workflow_step_definition','workflow_run','workflow_step_run',
    'trip','trip_destination','trip_leg','trip_traveller',
    'asset','asset_custody',
    'facility','facility_reservation'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- =============================================================================
-- PRIVILEGES
-- =============================================================================

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables: SELECT, INSERT, UPDATE, and NO DELETE.
GRANT SELECT, INSERT, UPDATE ON
  task, task_dependency,
  workflow_definition, workflow_step_definition, workflow_run,
  trip, trip_destination, trip_leg, trip_traveller,
  asset,
  facility, facility_reservation
TO raptor_app;

-- Governance data. An organisation editing its own legal task machine from a
-- request handler is "a stage table the app role can rewrite is not a state
-- machine", which 0008 argues about `hr_state_transition` and 0009 about
-- `partner_state_transition`. Only a migration or an operator changes these.
REVOKE INSERT, UPDATE, DELETE ON
  task_state_transition
FROM raptor_app;

-- Append-only tables: SELECT and INSERT only. Stated as an explicit REVOKE as
-- well as an absent GRANT, so a later migration that widens a grant cannot
-- accidentally hand back an UPDATE by omission.
GRANT SELECT, INSERT ON
  task_transition, asset_custody, workflow_step_run
TO raptor_app;

REVOKE UPDATE, DELETE ON
  task_transition, asset_custody, workflow_step_run
FROM raptor_app;

-- No hard deletes anywhere in this domain.
REVOKE DELETE ON
  task, task_dependency, task_state_transition,
  workflow_definition, workflow_step_definition, workflow_run, workflow_step_run,
  trip, trip_destination, trip_leg, trip_traveller,
  asset, asset_custody,
  facility, facility_reservation
FROM raptor_app;

-- PUBLIC's automatic EXECUTE is taken back from every function, so a role with no
-- grants on the tables cannot reach the logic through a function.
REVOKE ALL ON FUNCTION public.workflow_retry_token(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_derived_status_in_org(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_task_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_workflow_run_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_task_matches_its_step() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_step_matches_its_task() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_trip_traveller_consent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_asset_custody() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.asset_holder_at(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.asset_custody_trail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_facility_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.derive_workflow_step_run_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_task_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created_operations() FROM PUBLIC;

-- The derivations and reports. The guards and seeding functions are NOT granted,
-- because a role that can call a guard directly has no use for it — they are
-- reachable only through a write.
GRANT EXECUTE ON FUNCTION
  public.workflow_derived_status_in_org(uuid, uuid),
  public.asset_holder_at(uuid, uuid, timestamptz),
  public.asset_custody_trail(uuid)
TO raptor_app;

COMMIT;
