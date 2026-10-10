-- =============================================================================
-- packages/db/migrations/0009_commercial.sql
--
-- The COMMERCIAL + CONTENT bounded context, and the one public surface.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- -------------------------------------------
-- The design spec closes Phase 5 on one sentence: "Obligation fulfilment provable end
-- to end". Read carefully, "end to end" is the whole of the claim. A sponsorship that
-- says "4 streams, 2 social posts, appear at the final" is provable only if every link in
-- that chain is separately checkable: what was owed, what was promised as evidence, what
-- was actually delivered, and what discharged it — with no step that can be quietly
-- skipped or faked. The failure this rebuild exists to prevent is an organisation marking
-- a sponsorship "fulfilled" with nothing behind it.
--
-- So the five properties below are enforced BY THE DATABASE, and each has a named test in
-- `src/commercial.isolation.test.ts`:
--
--   1. A parent obligation is NEVER directly fulfilled. It is discharged only as an
--      AGGREGATE of its parts.
--   2. Fulfilment requires evidence, and every evidence record carries its provenance:
--      who captured it, when, and whether a machine derived it or a human asserted it.
--   3. Evidence is append-only. A retraction is a new row, never a mutation or a delete.
--   4. The whole chain is answerable from ONE query, and the stored parent state cannot
--      drift from it.
--   5. Quantities are exact, and over-fulfilment is a distinct reportable state.
--
-- Property 4 is where the design earns or loses. There are two ways to hold a discharge
-- state: store it and trust it, or derive it on every read. Deriving is honest but makes
-- "where is this sponsorship" a fold over evidence; storing is fast but is exactly the
-- flag that can drift. This file does BOTH and makes the stored value a CONSTRAINT on the
-- derived one:
--
--   * `obligation_derived_state_in_org` is the single definition of the aggregate.
--   * `contract_obligation.state` is the cached aggregate a screen reads.
--   * `assert_obligation_discharge_consistent` re-derives at COMMIT and refuses any
--     transaction that leaves the two disagreeing.
--
-- The stored value therefore cannot drift, including in the case a hand-set flag cannot
-- survive: a retraction of the last supporting evidence row, in a transaction that does
-- not also move the parent back. That is refused, and the legal path — retract AND move
-- the parent, in one transaction — is the same shape as the ledger reversal 0004 uses for
-- a posted entry. The alternative, letting the flag go stale, is the defect.
--
-- WHY INVENTORY IS A LEDGER, NOT A BALANCE
-- -----------------------------------------
-- ADR-0016 recorded a drifting balance in the legacy slot system as a real defect, and
-- 0004 refused the stored counter for budgets on exactly that ground: "the counter drifted
-- away from the ledger it claimed to summarise — which is how a budget stops meaning
-- anything while still being displayed." So there is no `on_hand` column anywhere in this
-- schema. `inventory_item` says what a thing is, `inventory_movement` says what happened,
-- and `inventory_position` derives the position on every read.
--
-- The one thing a ledger can still get wrong is handing out more than you hold, so that
-- is checked — at COMMIT, by a DEFERRABLE CONSTRAINT TRIGGER, because a batch of movements
-- for one delivery must be judged as a batch. An IMMEDIATE check would refuse a batch
-- that fits and admit one that does not, depending on the order the rows arrived in.
--
-- A COMMITMENT is a movement of kind `commitment` that changes the committed figure
-- WITHOUT changing what is owned. That is the whole of "what the org owns or has
-- committed", and keeping the two apart means `available = on_hand - committed` is a
-- derivation rather than a second counter that can disagree with the first.
--
-- WHY CREATORS ARE `person` ROWS
-- ------------------------------
-- ADR-0018 forbids a second identity model. A creator is therefore a `person` with a
-- `creator_profile` beside it — not a `creator` table carrying its own name, email and
-- credentials. `creator_profile.person_id` is NOT NULL and carries a SINGLE-COLUMN foreign
-- key, which is correct rather than a lapse: `person` is org-independent by design, so a
-- composite FK to it is neither expressible nor wanted. The test asserts the column list,
-- so a future migration that adds `creator_profile.email` fails rather than ships.
--
-- WHY IRREVERSIBILITY IS ENFORCED ON THE TRANSITION TABLE ITSELF
-- -----------------------------------------------------------
-- An `is_irreversible` column nobody reads is a comment. So irreversibility is enforced
-- where it can actually be broken: a transition marked one-way may not have its reverse
-- declared. A later migration, or an operator with psql, cannot quietly add
-- `signed → negotiation` after `negotiation → signed` was recorded as one-way. The guard
-- is on `partner_state_transition`, not on `partner`, because that is the only place the
-- damage can be done.
--
-- WHY AN INVOICE TOTAL IS A CONSTRAINT, NOT A COLUMN
-- --------------------------------------------------
-- 0004's reconciliation already made this argument for the ledger: a stored figure that
-- disagrees with the rows it summarises is a stored lie. So `invoice.total_amount` is
-- CHECKed against the sum of its lines at COMMIT, every line must be in the header's
-- currency (an invoice that balances across two currencies is a conversion performed at no
-- rate by nobody), an issued invoice must have at least one line, and `paid` requires a
-- settlement journal — so "paid" is not a claim the database cannot contradict.
--
-- THE PUBLIC SURFACE, AND WHERE PUBLIC COLLIDES WITH MULTI-TENANT
-- ----------------------------------------------------------------
-- This is the one place the two collide, so the decision is stated rather than implied.
--
-- MAY be read with NO tenant filter: an organisation's slug, display name and status, and
-- the PUBLISHED projections of its content items. Nothing else.
--
-- MUST NEVER be read with no tenant filter: obligations, evidence, retractions, invoices,
-- invoice lines, inventory movements, partners, creator private details, contracts, and
-- anything at all about a person.
--
-- The mechanism is NOT a `SECURITY DEFINER` view over the tenant tables. Such a view is
-- correct only while nobody remembers to widen it, and it re-introduces RLS elevation —
-- which is precisely what this schema spends 0001 through 0008 refusing to hand out.
-- Instead:
--
--   * `public_site_publication` is a DENORMALISED, publish-time MATERIALISATION carrying
--     only columns vetted as publishable when the row was written: id, org_id,
--     content_item_id, creator_handle, title, body, published_at. There is no obligation
--     id, no invoice, no amount, no contact, and no person id — not "hidden by policy",
--     but ABSENT.
--   * It is written by exactly one function, `publish_content_to_public_site`, which takes
--     the organisation from `current_org_id()` and NEVER from a parameter, and which
--     refuses content that is not in the `published` state. An unset tenant context fails
--     closed.
--   * `public_site_org` exposes three organisation columns and no more, so the public
--     role can be granted the projection and the org's public name and NOTHING else —
--     asserted over the catalogue, grant by grant.
--   * `public_site_content(slug)` reads those two, joins on `org_id` throughout, and
--     returns nothing for an organisation that is not `active`. It is SECURITY INVOKER,
--     so no elevation exists to misuse.
--
-- The consequence is the property the test asserts: a public read cannot cross an
-- organisation boundary because the address IS the boundary, and it cannot expose a
-- private fact because the public relation does not contain one.
--
-- TENANCY
-- -------
-- Identical to 0001/0002/0006/0007/0008 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK between tenant
-- tables composite and including org_id, RLS ENABLED *and* FORCED with the tenant
-- predicate as the whole policy and no IS NULL escape (ADR-0015).
--
-- `public_site_publication` is the ONE deliberate exception and carries NO policy. That is
-- a decision with a mechanism rather than a gap: it is populated only through a
-- session-scoped publisher and holds no private column, and the test asserts both facts.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only tables carry
-- none, because on a table where UPDATE is impossible an archive column is a column
-- permanently NULL (the 0004 header states that rule; this file obeys it).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

-- What was promised. Each value is a thing a sponsor can be told they got, and each has
-- its own quantity and its own evidence — which is the whole point of the aggregate.
CREATE TYPE obligation_part_kind AS ENUM (
  'live_stream', 'social_post', 'appearance', 'video', 'logo_placement',
  'jersey_inclusion', 'content_delivery', 'custom'
);

-- Two values only. A third one — 'waived', 'at_risk', 'partially_fulfilled' — would be a
-- place for a caller to record a judgement the evidence does not support. The intermediate
-- position an obligation is genuinely in ("some parts done, some not") is carried by the
-- PARENT's state, which is derived; the part itself is binary on purpose.
CREATE TYPE obligation_part_state AS ENUM ('outstanding', 'fulfilled');

-- The cached aggregate, and the only states it may take. There is deliberately no
-- 'fulfilled' boolean: the string is the claim, the deferred trigger is what makes it
-- honest, and a boolean would let the same claim be expressed in a shape nothing checks.
CREATE TYPE obligation_discharge_status AS ENUM ('open', 'partially_fulfilled', 'discharged');

-- ADR-0019's finding was that the legacy system stored a hardcoded confidence of 85 beside
-- facts nobody could trace, so a machine read and a hand-typed row stayed
-- indistinguishable forever. The provenance is therefore a first-class enum with two
-- values, and the CHECK below binds each to the fields it actually requires — so neither
-- "an OCR row with nothing behind it" nor "a typed row wearing an OCR provenance" is
-- storable.
CREATE TYPE obligation_evidence_origin AS ENUM ('machine_derived', 'human_asserted');

CREATE TYPE partner_stage AS ENUM (
  'lead', 'qualified', 'negotiation', 'signed', 'active', 'lapsed'
);

CREATE TYPE content_stage AS ENUM (
  'draft', 'review', 'approved', 'scheduled', 'published', 'archived'
);

CREATE TYPE invoice_state AS ENUM ('draft', 'issued', 'paid', 'void');

-- WHY THE SIGN IS BOUND TO THE KIND
-- ----------------------------------
-- A receipt that subtracts is either a typo or a lie, and both make the derived position
-- wrong in a way nobody could later detect. `adjustment` is the only kind that may go
-- either way, because that is exactly what a recount is.
CREATE TYPE inventory_movement_kind AS ENUM (
  'receipt', 'issue', 'commitment', 'release', 'adjustment', 'write_off'
);

-- -----------------------------------------------------------------------------
-- THE PARTNERSHIP AND ITS OBLIGATIONS
-- -----------------------------------------------------------------------------

-- A partner is a commercial counterparty, NOT a person. The schema refuses to pretend
-- otherwise by giving this table no `person_id`: the people who work at a partner are
-- recorded where a contract needs them to be — as the party to `contract` — and inventing
-- a second identity model for an organisation's employees is exactly the ADR-0018 failure
-- wearing a CRM's clothes.
CREATE TABLE partner (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         varchar(200) NOT NULL,
  -- The commercial relationship's terms of record, as first-class columns rather than a
  -- note. `stage` is the one a pipeline is filtered by; the rest is what a signed
  -- partnership looks like when someone asks what was agreed.
  legal_name   varchar(240),
  website_url  text,
  stage        partner_stage NOT NULL DEFAULT 'lead',
  stage_reason varchar(400),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  stage_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- An INSTANT, not a `date`. The legal reasoning is 0003's and 0004's: a calendar date
  -- flattened from an instant resolves to a different day per reader's timezone, and a
  -- signed agreement date is a fact about a moment.
  contracted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT partner_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT partner_url_check CHECK (website_url IS NULL OR btrim(website_url) <> ''),
  CONSTRAINT partner_org_name_key UNIQUE (org_id, name),
  CONSTRAINT partner_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX partner_org_idx       ON partner (org_id);
CREATE INDEX partner_org_stage_idx ON partner (org_id, stage);

-- At most one LIVE partner by name. Two live rows with the same name make "who is our
-- Acme contact" ambiguous in a way a stage filter does not fix; a archived one coexists
-- because a former sponsor called Acme is still a former sponsor.
CREATE UNIQUE INDEX partner_current_name_key
  ON partner (org_id, name) WHERE archived_at IS NULL;

COMMENT ON TABLE partner IS
  'A commercial counterparty. NOT a person: the people at a partner are parties to a contract, not rows here. The current stage is STORED here and the legal transitions are DATA in partner_state_transition, enforced by a trigger.';

-- -----------------------------------------------------------------------------
-- THE OBLIGATION AND ITS PARTS
-- -----------------------------------------------------------------------------

-- The PROMISE. It carries no quantity and no fulfilment claim of its own beyond the
-- CACHED aggregate in `state`, which `assert_obligation_discharge_consistent` re-derives
-- at COMMIT. An obligation with no parts can never be discharged: nothing was promised in
-- a form that could be fulfilled, so nothing can have been.
CREATE TABLE contract_obligation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The contract it was owed under. An obligation that names no contract is a wish, and
  -- the composite FK makes a cross-tenant reference to one unexpressible (ADR-0011).
  contract_id uuid NOT NULL,
  -- Which commercial relationship this was agreed with. Nullable because a legacy
  -- obligation imported from a contract sheet may predate any CRM record; when it IS set
  -- the composite FK still refuses another tenant's partner.
  partner_id  uuid,
  title       varchar(200) NOT NULL,
  description text,
  -- An INSTANT. A deadline that flattened to a date would make "was it late" resolve to a
  -- different day per reader's timezone (ADR-0003, and the legacy attendance backlog).
  due_at      timestamptz NOT NULL,
  -- The CACHED AGGREGATE. See the file header for why it exists and what stops it
  -- drifting. It is never a hand-set flag: the deferred trigger compares it with
  -- obligation_derived_state_in_org and refuses the COMMIT if they differ.
  state       obligation_discharge_status NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT contract_obligation_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_obligation_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES partner (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_obligation_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_obligation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_obligation_org_idx        ON contract_obligation (org_id);
CREATE INDEX contract_obligation_org_contract_idx ON contract_obligation (org_id, contract_id);
CREATE INDEX contract_obligation_org_partner_idx  ON contract_obligation (org_id, partner_id);
CREATE INDEX contract_obligation_org_due_idx      ON contract_obligation (org_id, due_at);
CREATE INDEX contract_obligation_org_state_idx    ON contract_obligation (org_id, state);

COMMENT ON TABLE contract_obligation IS
  'A promise owed under a contract. It is discharged only as an AGGREGATE of its parts: `state` is a cached aggregate that the database re-derives at COMMIT and refuses to let disagree with the parts and their evidence. An obligation with no parts is always ''open''.';

-- One part of a promise. A part is the unit that can be fulfilled, because a part has its
-- own quantity, its own deadline and its own evidence — "deliver 4 streams" cannot be
-- half done in a way a reader can check, whereas "3 of 4 streams delivered" can.
CREATE TABLE contract_obligation_part (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_id     uuid NOT NULL,
  kind              obligation_part_kind NOT NULL,
  -- A WHOLE COUNT, an integer, and never numeric(18,4): this is a number of streams, not
  -- money, and forcing it to a money scale would be a lie about what it is.
  promised_quantity integer NOT NULL,
  due_at            timestamptz NOT NULL,
  state             obligation_part_state NOT NULL DEFAULT 'outstanding',
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT contract_obligation_part_obligation_fk
    FOREIGN KEY (org_id, obligation_id)
    REFERENCES contract_obligation (org_id, id) ON DELETE RESTRICT,
  -- Strictly positive. Zero is the "fulfilled with nothing behind it" defect wearing a
  -- quantity's name: a part promising nothing is discharged the instant it is created.
  CONSTRAINT contract_obligation_part_quantity_check CHECK (promised_quantity > 0),
  CONSTRAINT contract_obligation_part_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_obligation_part_org_idx            ON contract_obligation_part (org_id);
CREATE INDEX contract_obligation_part_org_obligation_idx ON contract_obligation_part (org_id, obligation_id);
CREATE INDEX contract_obligation_part_org_due_idx        ON contract_obligation_part (org_id, due_at);

-- NO unique index on (obligation, kind, quantity), and this is a decision rather than an
-- omission. An earlier draft of this file had one, on the reasoning that "two parts that
-- say the same thing twice make the promise ambiguous". That is wrong: a sponsorship that
-- promises "a stream at the group stage and a stream at the final" is two live_stream
-- parts of one unit each, and an index shaped that way would make the most ordinary
-- sponsorship unrepresentable. What makes a part distinguishable is its `due_at` and its
-- `description`, both of which are already there, and neither of which a uniqueness rule
-- can summarise without forbidding a legitimate case.

COMMENT ON TABLE contract_obligation_part IS
  'One promised deliverable with a quantity, a deadline and a fulfilment state. Mutable only in `state` (and by archiving a part written in error); the promise itself — the kind and the quantity — is frozen because a changed quantity is a different promise. Two parts of the same kind are ordinary (a stream at the group stage and a stream at the final), so nothing keys on (obligation, kind).';

-- -----------------------------------------------------------------------------
-- EVIDENCE — PROPERTY 2 AND 3
-- -----------------------------------------------------------------------------

-- WHAT WAS ACTUALLY DELIVERED, as an append-only record.
--
-- Append-only with no `archived_at`, because on a table where UPDATE is impossible an
-- archive column is a column permanently NULL (0004's rule). A mistake is corrected by a
-- RETRACTION, which is its own row: the evidence that something was claimed is not
-- permitted to vanish because the claim turned out to be wrong.
CREATE TABLE obligation_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_part_id uuid NOT NULL,
  -- HOW MANY UNITS THIS PROVES. Not a boolean. "Four streams" is satisfied by four rows
  -- of one, or one row of four, or any mix — the aggregate sums them, so the shape of
  -- the evidence does not decide whether the promise was kept.
  quantity           integer NOT NULL,
  origin             obligation_evidence_origin NOT NULL,
  -- WHEN THE ARTEFACT WAS CAPTURED, as an instant. Not `created_at`: a backfilled
  -- capture belongs to the month the stream went live, and filtering a report on the
  -- insert timestamp is how backfilled history lands in the present bucket (ADR-0019).
  captured_at        timestamptz NOT NULL,
  -- WHO ASSERTED IT. Required for a human assertion, forbidden for a machine read: a
  -- person either stood behind the claim or the machine did, and a row claiming both is
  -- a row nobody can audit.
  captured_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHICH MACHINE, and HOW SURE IT WAS. Both required for a machine read, both forbidden
  -- for a human assertion. `confidence` has NO DEFAULT: the legacy OCR path wrote 85
  -- into every row, and a default is how a constant gets to look like a measurement.
  extractor          varchar(160),
  -- Deliberately WIDER than the 0..1 range the CHECK below enforces, rather than exactly
  -- as wide as it. numeric(5,4) would refuse the legacy value 85 with a storage overflow
  -- before the constraint ever ran, which would mean the constraint is never actually
  -- tested — and a bound that has only ever been enforced by a type width is a bound that
  -- a later `numeric` change silently removes. The column must be able to hold a wrong
  -- confidence so that the CHECK is what refuses it.
  confidence         numeric(9,4),
  -- WHERE THE BYTES ARE. The file or the VOD lives outside this database; this is the
  -- pointer, and the pointer is what makes the row checkable by a human who does not
  -- trust the database.
  source_ref         text NOT NULL,
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_evidence_part_fk
    FOREIGN KEY (org_id, obligation_part_id)
    REFERENCES contract_obligation_part (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT obligation_evidence_quantity_check CHECK (quantity > 0),
  CONSTRAINT obligation_evidence_source_ref_check CHECK (btrim(source_ref) <> ''),
  -- The provenance binding, BOTH directions, in one CHECK so the two halves cannot drift
  -- apart when somebody edits it:
  --   machine_derived — an extractor AND a stated confidence, and no asserting person.
  --   human_asserted  — an asserting person, and no extractor and no confidence.
  -- A machine read naming a person, or a human assertion naming a machine, is refused:
  -- both make a corrected or hand-typed row indistinguishable from a machine reading.
  CONSTRAINT obligation_evidence_provenance_binding_check CHECK (
        CASE WHEN origin = 'machine_derived'
             THEN (extractor IS NOT NULL AND confidence IS NOT NULL AND captured_by_person_id IS NULL)
             ELSE (captured_by_person_id IS NOT NULL AND extractor IS NULL AND confidence IS NULL)
        END
      ),
  CONSTRAINT obligation_evidence_extractor_check
    CHECK (extractor IS NULL OR btrim(extractor) <> ''),
  -- 0..1, so the legacy "85" is not storable in a column that means a proportion. This is
  -- the mechanical form of "a number presented as a measurement while being an invented
  -- constant is the precise failure this rebuild exists to eliminate".
  CONSTRAINT obligation_evidence_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT obligation_evidence_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX obligation_evidence_org_idx   ON obligation_evidence (org_id);
CREATE INDEX obligation_evidence_org_part_idx ON obligation_evidence (org_id, obligation_part_id);
CREATE INDEX obligation_evidence_org_origin_idx ON obligation_evidence (org_id, origin);

COMMENT ON TABLE obligation_evidence IS
  'One piece of evidence that a part was delivered, with its provenance: who captured it, when, and whether a machine derived it or a human asserted it. Append-only, and a mistake is corrected by a retraction rather than an UPDATE (obligation_evidence_retraction).';

-- The retraction. A row, not a column, for the reason 0008 gives for
-- `acceptance_withdrawal`: the evidence is a fact about what happened, so the act that
-- takes it back must not be able to edit it. Both rows exist afterwards, and the reason
-- travels with the retraction rather than being written over the claim.
CREATE TABLE obligation_evidence_retraction (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_evidence_id  uuid NOT NULL,
  retracted_by_person_id  uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  retracted_at            timestamptz NOT NULL,
  reason                  varchar(400) NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_evidence_retraction_evidence_fk
    FOREIGN KEY (org_id, obligation_evidence_id)
    REFERENCES obligation_evidence (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT obligation_evidence_retraction_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT obligation_evidence_retraction_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX obligation_evidence_retraction_org_idx ON obligation_evidence_retraction (org_id);
CREATE INDEX obligation_evidence_retraction_org_evidence_idx
  ON obligation_evidence_retraction (org_id, obligation_evidence_id);

-- One retraction per evidence row. A second retraction of the same claim is a duplicate
-- notification, not a second event — and "was this retracted, and how many times" must
-- have one answer.
CREATE UNIQUE INDEX obligation_evidence_retraction_one_per_evidence_key
  ON obligation_evidence_retraction (org_id, obligation_evidence_id);

COMMENT ON TABLE obligation_evidence_retraction IS
  'One retraction of one evidence row. The evidence row survives and still says what it said; only the SUPPORT is withdrawn, and the reason travels with the retraction.';

-- -----------------------------------------------------------------------------
-- THE DERIVATION — ONE DEFINITION, WRITTEN ONCE
-- -----------------------------------------------------------------------------

-- How much of a part is actually supported, counting only evidence nobody has retracted.
--
-- The subtraction is expressed as a LEFT JOIN with an IS NULL test rather than
-- "subtract the retracted rows", because the two are equivalent only while a retraction
-- exists for zero or one row per evidence — which UNIQUE (org_id, obligation_evidence_id)
-- guarantees, but which a future migration could relax. The EXISTS form then keeps
-- meaning what it says.
CREATE OR REPLACE FUNCTION public.obligation_part_supported_quantity(p_org_id uuid, p_part_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT sum(e.quantity)::integer
      FROM public.obligation_evidence e
     WHERE e.org_id             = p_org_id
       AND e.obligation_part_id = p_part_id
       AND NOT EXISTS (
             SELECT 1
               FROM public.obligation_evidence_retraction r
              WHERE r.org_id                 = e.org_id
                AND r.obligation_evidence_id = e.id
           )
  ), 0)
$$;

COMMENT ON FUNCTION public.obligation_part_supported_quantity(uuid, uuid) IS
  'Units of a part supported by evidence that has not been retracted. Takes an EXPLICIT organisation because it is the definition the integrity triggers below use, and a constraint must not depend on session state (the reasoning of guardian_consent_covers_in_org in 0008).';

-- The state of one part, as a REPORTABLE string rather than a stored column.
--
-- Six states, and the two in the middle are the ones a naive schema cannot express:
--
--   not_started    outstanding, nothing evidenced. What the legacy system looked like.
--   in_progress    outstanding, some evidence exists. Real work, not yet a promise kept.
--   under_fulfilled 'fulfilled' on the part row while the evidence does not support it.
--                   Reachable ONLY by retracting evidence after fulfilment, which the
--                   part row — append-only evidence, immutable claim — cannot record. It
--                   is reported rather than hidden because hiding it is how a dispute
--                   becomes unanswerable.
--   fulfilled      'fulfilled' and supported exactly meets the promise.
--   over_fulfilled 'fulfilled' and the evidence EXCEEDS the promise.
--
-- THE DECISION ON OVER-FULFILMENT, stated because it is a judgement and not a law:
-- over-fulfilment does NOT block the discharge, and it is NOT an error. A sponsor who got
-- five streams instead of four is owed nothing further and the obligation IS discharged;
-- `over_fulfilled` is a reportable surplus. Refusing it would make generosity
-- unrepresentable — the org could not record that it over-delivered — and silently
-- absorbing it would make it unreportable, which is the defect this file exists to
-- remove. So the surplus is named, summed and shown, and the discharge proceeds.
CREATE OR REPLACE FUNCTION public.obligation_part_discharge_status(p_org_id uuid, p_part_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p.archived_at IS NOT NULL                        THEN 'archived'
           WHEN p.state = 'outstanding' AND s.supported = 0        THEN 'not_started'
           WHEN p.state = 'outstanding'                            THEN 'in_progress'
           WHEN s.supported <  p.promised_quantity                  THEN 'under_fulfilled'
           WHEN s.supported >  p.promised_quantity                  THEN 'over_fulfilled'
           ELSE 'fulfilled'
         END
  FROM public.contract_obligation_part p
  CROSS JOIN LATERAL (
    SELECT public.obligation_part_supported_quantity(p.org_id, p.id) AS supported
  ) s
 WHERE p.org_id = p_org_id
   AND p.id     = p_part_id
$$;

COMMENT ON FUNCTION public.obligation_part_discharge_status(uuid, uuid) IS
  'archived | not_started | in_progress | under_fulfilled | fulfilled | over_fulfilled for one part. Under-fulfilled means the part row claims fulfilment the evidence does not support — reachable only by retracting evidence, and REPORTED rather than hidden. Over-fulfilled is a reportable surplus and does NOT block the discharge.';

-- THE SINGLE DEFINITION OF DISCHARGE, and the thing property 4 turns on.
--
-- Three states and no fourth:
--
--   open                 no part is discharged. This includes "there are no parts at all",
--                        which is the purest form of the defect this file exists to
--                        prevent: nothing was promised in a checkable form, so nothing can
--                        have been delivered.
--   partially_fulfilled  at least one part is discharged and at least one is not.
--   discharged           the obligation has at least one part AND every one of them is
--                        fulfilled or over_fulfilled.
--
-- Two definitions on purpose, for the same reason 0008 splits
-- `guardian_consent_covers_in_org` from `guardian_consent_covers`: the integrity trigger
-- BELOW calls the one that takes an explicit organisation, because a trigger must evaluate
-- against the row it fires on and never against whatever tenant the session happens to
-- name. A constraint that can be switched off by not setting a variable is not a
-- constraint.
CREATE OR REPLACE FUNCTION public.obligation_derived_state_in_org(p_org_id uuid, p_obligation_id uuid)
RETURNS obligation_discharge_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH parts AS (
    SELECT p.id,
           p.state = 'fulfilled'
           AND public.obligation_part_supported_quantity(p.org_id, p.id) >= p.promised_quantity
             AS discharged
      FROM public.contract_obligation_part p
     WHERE p.org_id         = p_org_id
       AND p.obligation_id  = p_obligation_id
       AND p.archived_at IS NULL
  ),
  totals AS (
    SELECT count(*)::integer AS total,
           count(*) FILTER (WHERE discharged)::integer AS discharged
      FROM parts
  )
  -- The casts are schema-qualified because this function pins search_path to empty, and a
  -- body is parsed at CREATION time: an unqualified type name would not resolve there.
  -- That is a real constraint of the pinning, not a stylistic choice, and it is why every
  -- table and type in this file is referenced with its schema.
  SELECT CASE
           WHEN t.total = 0 OR t.discharged = 0 THEN 'open'::public.obligation_discharge_status
           WHEN t.discharged = t.total          THEN 'discharged'::public.obligation_discharge_status
           ELSE 'partially_fulfilled'::public.obligation_discharge_status
         END
    FROM totals t
$$;

COMMENT ON FUNCTION public.obligation_derived_state_in_org(uuid, uuid) IS
  'The aggregate discharge state of one obligation in one organisation, recomputed from its parts and their evidence. The SINGLE definition: contract_obligation.state is constrained to equal it at COMMIT, and every report reads it rather than reading the stored column. An obligation with no parts is always ''open''.';

-- The application-facing wrapper. It takes NO organisation argument (ADR-0011 rule 3), so
-- a caller cannot choose which tenant they ask about, and an unset context resolves to
-- NULL and therefore to ''open'' rather than to somebody else's data.
CREATE OR REPLACE FUNCTION public.obligation_derived_state(p_obligation_id uuid)
RETURNS obligation_discharge_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.obligation_derived_state_in_org(public.current_org_id(), p_obligation_id)
$$;

COMMENT ON FUNCTION public.obligation_derived_state(uuid) IS
  'The aggregate discharge state, with the tenant taken from the session. An unset context reads nothing, so it returns ''open'' rather than exposing another tenant''s obligation.';

-- -----------------------------------------------------------------------------
-- PROPERTY 2 — A PART CANNOT REACH 'fulfilled' WITHOUT THE EVIDENCE TO SUPPORT IT
-- -----------------------------------------------------------------------------

-- BEFORE UPDATE, so the row never exists in a state the database would refuse.
--
-- Immediate rather than deferred, deliberately. The ordering is not circular: evidence
-- names a part, so the part exists before the evidence does, so the evidence is always
-- written first and the claim second. Claiming fulfilment BEFORE the evidence exists is
-- not a legitimate ordering to support — it is the defect.
--
-- The comparison is `>=`, not `=`, because over-fulfilment is legitimate and reportable
-- (see obligation_part_discharge_status). What is refused is claiming more than has been
-- evidenced.
CREATE OR REPLACE FUNCTION public.guard_obligation_part_fulfilment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_supported integer;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state <> 'fulfilled' THEN
    RETURN NEW;
  END IF;

  v_supported := public.obligation_part_supported_quantity(NEW.org_id, NEW.id);

  IF v_supported < NEW.promised_quantity THEN
    RAISE EXCEPTION
      'obligation part % cannot be marked fulfilled: % unit(s) promised, % evidenced. A fulfilment claim the evidence does not support is the defect this schema exists to prevent.',
      NEW.id, NEW.promised_quantity, v_supported
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_obligation_part_fulfilment() IS
  'Refuses to mark an obligation part fulfilled unless the unretracted evidence for it covers the promised quantity. Fires BEFORE UPDATE, so the row never exists in the refused state. Over-fulfilment is allowed and reported; under-fulfilment is not.';

REVOKE ALL ON FUNCTION public.guard_obligation_part_fulfilment() FROM PUBLIC;

CREATE TRIGGER contract_obligation_part_needs_evidence
  BEFORE UPDATE OF state ON contract_obligation_part
  FOR EACH ROW EXECUTE FUNCTION public.guard_obligation_part_fulfilment();

-- -----------------------------------------------------------------------------
-- PROPERTY 4 — THE STORED STATE AND THE DERIVED AGGREGATE CANNOT DISAGREE
-- -----------------------------------------------------------------------------

-- THE guard that makes the stored `contract_obligation.state` honest.
--
-- Fires at COMMIT, on FOUR tables, because every one of them can change the answer:
--
--   contract_obligation          the claim itself is what is being checked
--   contract_obligation_part     a part fulfilled, archived, or re-promised
--   obligation_evidence          new support appears
--   obligation_evidence_retraction support is withdrawn
--
-- Deferred, because the only legal way to retract evidence is to retract it AND move the
-- parent back in ONE transaction — and an IMMEDIATE trigger would refuse the retraction
-- before the correction could be written. Deferring is what makes the ledger-reversal shape
-- 0004 uses for a posted entry expressible here.
--
-- WHY IT IS ATTACHED TO `obligation_evidence` AS WELL
-- ---------------------------------------------------
-- Without it, "mark the parent discharged" and "add the evidence" could be two separate
-- transactions, and between them the parent would be claiming a discharge no evidence
-- supports. The trigger makes them one atomic claim.
--
-- RAISES check_violation (23514): a stale aggregate is a violated claim about the row's
-- own parts, which is the same SQLSTATE every other integrity violation in this schema
-- reports, so one monitoring rule catches all of them.
CREATE OR REPLACE FUNCTION public.assert_obligation_discharge_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id        uuid;
  v_obligation_id uuid;
  -- Schema-qualified because this function pins search_path to empty, so an unqualified
  -- type name would not resolve. Every reference below is qualified for the same reason.
  v_stored        public.obligation_discharge_status;
  v_derived       public.obligation_discharge_status;
BEGIN
  -- Resolve WHICH obligation was touched, from whichever of the four tables fired.
  IF TG_TABLE_NAME = 'contract_obligation' THEN
    v_org_id        := NEW.org_id;
    v_obligation_id := NEW.id;

  ELSIF TG_TABLE_NAME = 'contract_obligation_part' THEN
    v_org_id        := NEW.org_id;
    v_obligation_id := NEW.obligation_id;

  ELSIF TG_TABLE_NAME = 'obligation_evidence' THEN
    v_org_id := NEW.org_id;
    SELECT p.obligation_id INTO v_obligation_id
      FROM public.contract_obligation_part p
     WHERE p.org_id = NEW.org_id AND p.id = NEW.obligation_part_id;

  ELSE
    v_org_id := NEW.org_id;
    SELECT p.obligation_id INTO v_obligation_id
      FROM public.obligation_evidence_retraction r
      JOIN public.obligation_evidence e
        ON e.org_id = r.org_id AND e.id = r.obligation_evidence_id
      JOIN public.contract_obligation_part p
        ON p.org_id = e.org_id AND p.id = e.obligation_part_id
     WHERE r.org_id = NEW.org_id AND r.id = NEW.id;
  END IF;

  IF v_obligation_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT o.state INTO v_stored
    FROM public.contract_obligation o
   WHERE o.org_id = v_org_id AND o.id = v_obligation_id;

  -- The obligation was archived or removed between the firing and here. Nothing to judge.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_derived := public.obligation_derived_state_in_org(v_org_id, v_obligation_id);

  IF v_stored IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION
      'obligation % stores state ''%'' but its parts and evidence aggregate to ''%''. An obligation is discharged only as an aggregate of its parts, so the stored state must equal the derivation; move the state to ''%'' in this same transaction.',
      v_obligation_id, v_stored, v_derived, v_derived
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_obligation_discharge_consistent() IS
  'Re-derives an obligation''s discharge state from its parts and their evidence at COMMIT and refuses any transaction that leaves contract_obligation.state disagreeing with it. Deferred, so retracting evidence and moving the parent back can be written as one transaction — the ledger-reversal shape 0004 uses.';

REVOKE ALL ON FUNCTION public.assert_obligation_discharge_consistent() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER contract_obligation_state_is_derived
  AFTER INSERT OR UPDATE ON contract_obligation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER contract_obligation_part_rejustifies_parent
  AFTER INSERT OR UPDATE OF state, promised_quantity, archived_at ON contract_obligation_part
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER obligation_evidence_rejustifies_parent
  AFTER INSERT ON obligation_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER obligation_evidence_retraction_rejustifies_parent
  AFTER INSERT ON obligation_evidence_retraction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

-- -----------------------------------------------------------------------------
-- THE CHAIN, ANSWERED FROM ONE PLACE
-- -----------------------------------------------------------------------------

-- PROPERTY 4's deliverable: for obligation O, which parts are done, which are
-- outstanding, what evidence supports each done part, and THEREFORE whether O is
-- discharged — one query, one row per part.
--
-- It reads the DERIVATION, not the stored column, for `derived_state`, and reports
-- `states_agree` beside it so a reader can see the two side by side without trusting
-- either. A report that computed its "therefore" from the same column it is checking would
-- be circular.
--
-- SECURITY INVOKER, deliberately: it reads and nothing more, so no elevation is wanted,
-- and every underlying table's RLS applies to it. It therefore exposes exactly what its
-- caller's policies expose and nothing wider — which is why a call in ORG_B's session for
-- ORG_A's obligation returns zero rows rather than zero-valued rows.
--
-- NO LIMIT. ADR-0019's finding was a `limit` that silently capped at 1000 and presented
-- the capped set as a ranking. A discharge report that returned an obligation's first 50
-- parts would be worse than useless, because the caller would have no way to tell.
--
-- `evidence_count` counts evidence rows that SURVIVE retraction. Retracted evidence is
-- not absent from history — it is in `obligation_evidence_retraction` — but it supports
-- nothing, and a count that included it would be a claim of support that does not exist.
CREATE OR REPLACE FUNCTION public.obligation_discharge_report(p_obligation_id uuid)
RETURNS TABLE (
  obligation_id      uuid,
  obligation_title   varchar(200),
  stored_state       obligation_discharge_status,
  derived_state      obligation_discharge_status,
  states_agree       boolean,
  part_id            uuid,
  part_kind          obligation_part_kind,
  promised_quantity  integer,
  supported_quantity integer,
  surplus_quantity   integer,
  part_state         obligation_part_state,
  discharge_status   text,
  evidence_count     integer,
  due_at             timestamptz,
  is_overdue         boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH obligation AS (
    SELECT o.id, o.title, o.state, o.org_id
      FROM public.contract_obligation o
     WHERE o.id = p_obligation_id
       AND o.org_id = public.current_org_id()
       AND o.archived_at IS NULL
  ),
  parts AS (
    SELECT p.*
      FROM public.contract_obligation_part p
     WHERE p.org_id = (SELECT org_id FROM obligation)
       AND p.obligation_id = p_obligation_id
       AND p.archived_at IS NULL
  ),
  per_part AS (
    SELECT pp.id,
           pp.org_id,
           pp.kind,
           pp.promised_quantity,
           pp.state,
           pp.due_at,
           public.obligation_part_supported_quantity(pp.org_id, pp.id) AS supported,
           (
             SELECT count(*)::integer
               FROM public.obligation_evidence e
              WHERE e.org_id             = pp.org_id
                AND e.obligation_part_id = pp.id
                AND NOT EXISTS (
                      SELECT 1
                        FROM public.obligation_evidence_retraction r
                       WHERE r.org_id                 = e.org_id
                         AND r.obligation_evidence_id = e.id
                    )
           ) AS evidence_count
      FROM parts pp
  )
  SELECT o.id,
         o.title,
         o.state,
         public.obligation_derived_state_in_org(o.org_id, o.id),
         (o.state = public.obligation_derived_state_in_org(o.org_id, o.id)),
         x.id,
         x.kind,
         x.promised_quantity,
         x.supported,
         GREATEST(x.supported - x.promised_quantity, 0),
         x.state,
         public.obligation_part_discharge_status(x.org_id, x.id),
         x.evidence_count,
         x.due_at,
         (x.due_at < now())
    FROM obligation o
    LEFT JOIN per_part x ON TRUE
   ORDER BY x.due_at NULLS FIRST, x.id
$$;

COMMENT ON FUNCTION public.obligation_discharge_report(uuid) IS
  'For one obligation: every promised part with what is evidenced against it, the derived aggregate, and whether the stored state agrees. Takes no organisation argument (ADR-0011 rule 3) and carries no LIMIT, because a report that silently capped its result set and presented it as the whole would be the defect ADR-0019 recorded.';

-- -----------------------------------------------------------------------------
-- INVENTORY
-- -----------------------------------------------------------------------------

-- WHAT A THING IS. No quantity and no balance: a balance is derived, and a stored balance
-- is the counter that drifts (ADR-0016's legacy slot system, and 0004's refusal to store
-- committed/spent/remaining on a budget).
--
-- Effective-dated half-open, exactly as 0002 does it: `valid_to IS NULL` means current and
-- `valid_to > valid_from` means the window is real. Two live windows for one SKU would make
-- "which version of this thing was in force on that date" answerable two ways, so the
-- database refuses one by trigger rather than leaving it to a query to disambiguate.
CREATE TABLE inventory_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sku         varchar(64) NOT NULL,
  name        varchar(200) NOT NULL,
  -- THE UNIT, NAMED. ADR-0019's lesson about `survival_time` is that a count without a
  -- unit is a number nobody can check later; "6" chairs and "6" cases are the same row
  -- shape and a completely different fact.
  unit        varchar(24) NOT NULL,
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT inventory_item_sku_check CHECK (btrim(sku) <> ''),
  -- A lowercase or spaced unit is a typo that nobody notices for a year.
  CONSTRAINT inventory_item_unit_check CHECK (unit ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT inventory_item_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT inventory_item_window_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT inventory_item_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX inventory_item_org_idx        ON inventory_item (org_id);
CREATE INDEX inventory_item_org_valid_idx ON inventory_item (org_id, valid_from, valid_to);

-- ONE LIVE ROW PER SKU, and this is where effective dating has to be reconciled with
-- uniqueness.
--
-- An earlier draft of this file carried `UNIQUE (org_id, sku)`, and it contradicts the
-- supersession model this same table implements: a superseded item KEEPS its row, closes
-- its window, and is followed by a NEW row for the same SKU. Under a blanket UNIQUE,
-- supersession is unexpressible and the overlap guard below would be guarding something
-- the schema already forbids outright, so the guard could never fire and its test would
-- have been passing for the wrong reason.
--
-- Uniqueness is therefore on the CURRENT row only, and the guard handles the history:
-- overlapping CLOSED windows are still refused, which is what makes "which version was in
-- force on that date" have exactly one answer across the whole history and not merely
-- across the live set.
CREATE UNIQUE INDEX inventory_item_current_sku_key
  ON inventory_item (org_id, sku) WHERE valid_to IS NULL;

-- At most one CURRENT window per SKU. Enforced by a trigger rather than a unique index
-- because the index can only see this table, and the question "are two windows for one SKU
-- overlapping?" needs to be asked of the whole history.
CREATE OR REPLACE FUNCTION public.guard_inventory_window_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_other record;
BEGIN
  IF NEW.valid_to IS NULL THEN
    -- A new current window conflicts with every window that is still open, and with any
    -- window that closes after this one starts.
    SELECT i.id, i.valid_from INTO v_other
      FROM public.inventory_item i
     WHERE i.org_id = NEW.org_id
       AND i.sku    = NEW.sku
       AND i.id    <> NEW.id
       AND i.valid_to IS NULL
       AND NEW.valid_from < COALESCE(i.valid_to, 'infinity'::timestamptz)
       AND i.valid_from < COALESCE(NEW.valid_to, 'infinity'::timestamptz)
     LIMIT 1;
  ELSE
    SELECT i.id, i.valid_from INTO v_other
      FROM public.inventory_item i
     WHERE i.org_id = NEW.org_id
       AND i.sku    = NEW.sku
       AND i.id    <> NEW.id
       AND i.valid_from < NEW.valid_to
       AND NEW.valid_from < COALESCE(i.valid_to, 'infinity'::timestamptz)
     LIMIT 1;
  END IF;

  IF FOUND THEN
    RAISE EXCEPTION
      'inventory item % for sku % overlaps an existing window (item % open from %), so "which version was in force on that date" would have two answers',
      NEW.id, NEW.sku, v_other.id, v_other.valid_from
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_inventory_window_overlap() IS
  'Refuses an effective-dated window that overlaps another window for the same SKU, so an as-of query has exactly one answer. Half-open, exactly like 0002''s effective dating.';

REVOKE ALL ON FUNCTION public.guard_inventory_window_overlap() FROM PUBLIC;

CREATE TRIGGER inventory_item_windows_do_not_overlap
  BEFORE INSERT OR UPDATE OF sku, valid_from, valid_to ON inventory_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_inventory_window_overlap();

-- WHAT HAPPENED. Append-only: a stock movement is a fact about a moment, so a mistake is
-- corrected by a reversing movement rather than by editing the original — the same rule
-- 0004 applies to a journal line, for the same reason.
CREATE TABLE inventory_movement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL,
  kind        inventory_movement_kind NOT NULL,
  -- SIGNED. Positive increases, negative decreases, and the CHECK below binds the sign to
  -- the kind so "a receipt of minus five" is unstoreable rather than merely surprising.
  -- `adjustment` is the one kind allowed either way, because that is what a recount is.
  quantity    integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  -- WHAT THIS MOVEMENT WAS FOR. An 'issue' with no reference is stock that vanished, and
  -- stock that vanishes is the defect a movements ledger exists to make visible.
  reference   varchar(200) NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_item_fk
    FOREIGN KEY (org_id, item_id) REFERENCES inventory_item (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_sign_check CHECK (
        quantity <> 0
        AND (
          (kind = 'adjustment')
          OR ((kind IN ('receipt', 'commitment')) = (quantity > 0))
          OR ((kind IN ('issue', 'write_off', 'release')) = (quantity < 0))
        )
      ),
  CONSTRAINT inventory_movement_reference_check CHECK (btrim(reference) <> ''),
  CONSTRAINT inventory_movement_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX inventory_movement_org_idx       ON inventory_movement (org_id);
CREATE INDEX inventory_movement_org_item_idx  ON inventory_movement (org_id, item_id);
CREATE INDEX inventory_movement_org_time_idx  ON inventory_movement (org_id, occurred_at);

COMMENT ON TABLE inventory_movement IS
  'One stock movement: what happened, in which direction, when, and why. Append-only with no archived_at — a mistake is corrected by a reversing movement, because a movement is a fact about a moment. The position is DERIVED (inventory_position); no balance is stored anywhere.';

-- The derived position. Three figures and the arithmetic between them, recomputed on every
-- read so none can drift:
--
--   on_hand    receipt + return + adjustments — issue — write_off. What is physically there.
--   committed  commitments — releases. What is promised to somebody and not yet ours.
--   available  on_hand — committed. What could honestly be promised to somebody else.
--
-- A commitment deliberately does NOT move on_hand: it is not stock, and treating it as
-- stock would let an org promise the same chair twice. It is its own figure, and
-- `available` is the subtraction.
CREATE VIEW inventory_position AS
SELECT i.org_id,
       i.id AS item_id,
       i.sku,
       i.name,
       i.unit,
       i.valid_from,
       i.valid_to,
       COALESCE(x.on_hand, 0)   AS on_hand,
       COALESCE(x.committed, 0) AS committed,
       COALESCE(x.on_hand, 0) - COALESCE(x.committed, 0) AS available,
       COALESCE(x.movements_counted, 0) AS movements_counted
  FROM inventory_item i
  LEFT JOIN LATERAL (
    SELECT sum(m.quantity) FILTER (
             WHERE m.kind IN ('receipt', 'issue', 'adjustment', 'write_off')
           ) AS on_hand,
           sum(m.quantity) FILTER (
             WHERE m.kind IN ('commitment', 'release')
           ) AS committed,
           count(*) AS movements_counted
      FROM inventory_movement m
     WHERE m.org_id  = i.org_id
       AND m.item_id = i.id
  ) x ON true;

COMMENT ON VIEW inventory_position IS
  'Derived stock position: on_hand, committed and available, all recomputed from inventory_movement on every read. No counter is stored, so none can drift. available is on_hand minus committed, and a commitment deliberately does not move on_hand — it is stock promised, not stock held.';

-- The one thing a movements ledger can still get wrong, and the reason the balance is
-- checked at COMMIT rather than trusted.
--
-- You cannot hand out chairs you do not have. A commitment is NOT checked, because
-- committing stock that has not arrived yet is normal — an org promises a venue's worth of
-- kit before the shipment lands — so `available` may legitimately go negative, and that
-- negative is a reportable fact rather than an error.
--
-- DEFERRABLE so a batch of movements for one delivery is judged ONCE, against the total.
-- An IMMEDIATE trigger would evaluate each row alone and would therefore reject a batch
-- that fits (receipt after issue) and accept one that does not (issue before receipt).
CREATE OR REPLACE FUNCTION public.assert_inventory_not_oversold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id  uuid;
  v_item_id uuid;
  v_on_hand integer;
BEGIN
  v_org_id  := NEW.org_id;
  v_item_id := NEW.item_id;

  SELECT COALESCE(sum(m.quantity) FILTER (
           WHERE m.kind IN ('receipt', 'issue', 'adjustment', 'write_off')
         ), 0)::integer
    INTO v_on_hand
    FROM public.inventory_movement m
   WHERE m.org_id  = v_org_id
     AND m.item_id = v_item_id;

  IF v_on_hand < 0 THEN
    RAISE EXCEPTION
      'inventory item % stands at % unit(s) after this movement; stock cannot be issued below zero. A balance that can go negative without comment is exactly the drifting counter ADR-0016 recorded.',
      v_item_id, v_on_hand
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_inventory_not_oversold() IS
  'Refuses a COMMIT that would leave an item''s on_hand negative. Deferred to COMMIT so a batch of movements is judged as a batch. Commitments are NOT checked, because promising stock before it arrives is normal and a negative `available` is a reportable fact rather than an error.';

REVOKE ALL ON FUNCTION public.assert_inventory_not_oversold() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER inventory_movement_must_not_oversell
  AFTER INSERT ON inventory_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_inventory_not_oversold();

-- -----------------------------------------------------------------------------
-- PARTNER PIPELINE — A STATE MACHINE
-- -----------------------------------------------------------------------------

-- Mirrors hr_state_transition in 0008 exactly: the CURRENT stage is STORED on the row
-- (one indexed read rather than a fold over history), and the ALLOWED MOVES are DATA in
-- this table, so "what can happen to a lapsed deal" is a SELECT and not a reading of
-- application source. The database enforces them.
--
-- WHAT THE DATABASE DOES NOT ENFORCE, said plainly because 0008 says it of the HR
-- machine and it is true here too: it does not check WHO may make a transition.
-- Authorisation is packages/auth's concern and a migration cannot see which session a
-- write came from. This is about the LEGALITY of the move, not authority to make it.
CREATE TABLE partner_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_stage   partner_stage NOT NULL,
  to_stage     partner_stage NOT NULL,
  requires_reason boolean NOT NULL DEFAULT false,
  -- WHY THIS COLUMN IS ENFORCED RATHER THAN DECORATED
  -- ------------------------------------------------
  -- True means: the reverse move (`to_stage → from_stage`) may NEVER be declared in this
  -- table. A later migration, or an operator with psql, cannot quietly add
  -- `signed → negotiation` after `negotiation → signed` was recorded as one-way. Without
  -- the guard below, `is_irreversible` would be a comment, and a comment is not a
  -- constraint.
  is_irreversible boolean NOT NULL DEFAULT false,
  description  varchar(300),
  CONSTRAINT partner_state_transition_key UNIQUE (org_id, from_stage, to_stage),
  CONSTRAINT partner_state_transition_no_self_check CHECK (from_stage <> to_stage),
  CONSTRAINT partner_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX partner_state_transition_org_idx ON partner_state_transition (org_id);

CREATE OR REPLACE FUNCTION public.seed_partner_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.partner_state_transition (org_id, from_stage, to_stage, requires_reason, is_irreversible, description)
  VALUES
    (p_org_id, 'lead',        'qualified',   false, false, 'Qualified after a first conversation'),
    (p_org_id, 'lead',        'lapsed',      true,  true,  'Never engaged'),
    (p_org_id, 'qualified',   'negotiation', false, false, 'Terms being discussed'),
    (p_org_id, 'qualified',   'lapsed',      true,  true,  'Went with a competitor'),
    (p_org_id, 'negotiation', 'signed',      false, true,  'Agreement executed'),
    (p_org_id, 'signed',      'active',      false, true,  'First delivery under way'),
    (p_org_id, 'signed',      'lapsed',      true,  true,  'Agreement terminated before activation'),
    (p_org_id, 'active',      'lapsed',      true,  true,  'Relationship ended')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_partner_state_transition(uuid) IS
  'Seeds an organisation''s legal partner moves. `negotiation → signed`, `signed → active` and every move into `lapsed` are marked irreversible, so no reverse of them can ever be declared.';

REVOKE ALL ON FUNCTION public.seed_partner_state_transition(uuid) FROM PUBLIC;

-- The irreversibility guard. BEFORE INSERT OR UPDATE on the TRANSITION TABLE, because
-- that is the only place the damage can be done — guarding `partner` instead would stop
-- the wrong write and leave the machine free to grow a way back.
--
-- `exclusion_violation` (23P01) rather than check_violation, matching
-- `guard_performance_supersession` in 0007: it is what a declarative constraint would
-- raise for exactly this shape (two moves that may not coexist), so moving to one on a
-- full server is not an observable change to any caller.
--
-- Only IRREVERSIBLE transitions are checked against their reverse. A reversible move may
-- obviously be reversed — an ordinary renegotiation from qualified back to lead is real
-- work — so "no backwards moves" would be the wrong rule and is not the rule here.
-- One rule, TWO trigger functions.
--
-- The duplication is deliberate and it is the smallest useful duplication available. A
-- single function branching on `TG_TABLE_NAME` reads tidier, and it is wrong: PL/pgSQL
-- caches each statement's plan against the row type of the FIRST record it is handed, so
-- a function that reads `NEW.from_stage` in one branch and `NEW.from_state` in another
-- resolves both against whichever table fired first. The failure is a "column does not
-- exist" raised from a seed, which reads like a typo and is actually a plan-cache
-- artefact — and it would appear only in whichever table was seeded second.
--
-- The SHARED part is the refusal itself, which is the part that could actually drift:
-- `reject_irreversible_reverse` is the only place the error is raised and the only place
-- the reason is written down.
CREATE OR REPLACE FUNCTION public.reject_irreversible_reverse(
  p_label text,
  p_from  text,
  p_to    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    '% % — % cannot be declared: % — % is recorded as irreversible, and a one-way move must not grow a way back',
    p_label, p_from, p_to, p_to, p_from
    USING ERRCODE = 'exclusion_violation';
END
$$;

COMMENT ON FUNCTION public.reject_irreversible_reverse(text, text, text) IS
  'The single place the irreversibility refusal is raised. Both transition-table guards call it, so the two can never disagree about what a one-way move means.';

CREATE OR REPLACE FUNCTION public.guard_partner_transition_irreversibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_forward record;
BEGIN
  -- Only a REVERSIBLE move can possibly close a loop. If the move being declared is
  -- itself irreversible, its forward partner is the one that will be refused when IT is
  -- declared; checking here as well would refuse both halves of a legitimate chain.
  IF NEW.is_irreversible THEN
    RETURN NEW;
  END IF;

  SELECT t.id, t.is_irreversible INTO v_forward
    FROM public.partner_state_transition t
   WHERE t.org_id     = NEW.org_id
     AND t.from_stage = NEW.to_stage
     AND t.to_stage   = NEW.from_stage
   LIMIT 1;

  IF FOUND AND v_forward.is_irreversible THEN
    PERFORM public.reject_irreversible_reverse(
      'partner transition', NEW.from_stage::text, NEW.to_stage::text);
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_content_transition_irreversibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_forward record;
BEGIN
  IF NEW.is_irreversible THEN
    RETURN NEW;
  END IF;

  SELECT t.id, t.is_irreversible INTO v_forward
    FROM public.content_state_transition t
   WHERE t.org_id     = NEW.org_id
     AND t.from_state = NEW.to_state
     AND t.to_state   = NEW.from_state
   LIMIT 1;

  IF FOUND AND v_forward.is_irreversible THEN
    PERFORM public.reject_irreversible_reverse(
      'content state transition', NEW.from_state::text, NEW.to_state::text);
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_partner_transition_irreversibility() IS
  'Refuses to declare the reverse of a partner transition marked irreversible. Enforced on the transition TABLE rather than on partner, because the table is the only place a later migration could quietly grow a way back. Reversible moves may still be reversed.';

COMMENT ON FUNCTION public.guard_content_transition_irreversibility() IS
  'The content-table sibling of guard_partner_transition_irreversibility. Separate because PL/pgSQL caches a statement plan against the first NEW row type it sees; the shared refusal is reject_irreversible_reverse.';

-- REVOKEd from PUBLIC immediately, so the elevation is reachable only by declaring a
-- transition. Repeated in the privileges block at the foot of the file with the rest.
REVOKE ALL ON FUNCTION public.reject_irreversible_reverse(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition_irreversibility() FROM PUBLIC;

CREATE TRIGGER partner_state_transition_is_one_way
  BEFORE INSERT OR UPDATE OF from_stage, to_stage, is_irreversible ON partner_state_transition
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_transition_irreversibility();

-- The stage guard. The same shape as `guard_hr_transition` in 0008, for the same reasons:
-- the state is stored, the transitions are data, and an application that writes an illegal
-- move gets check_violation from the DATABASE rather than a silently illegal record.
CREATE OR REPLACE FUNCTION public.guard_partner_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    -- Not a transition. An edit to the reason text alone is not a stage change and is not
    -- guarded, because refusing it would make the row uneditable in every other respect.
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.partner_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_stage = OLD.stage
     AND t.to_stage   = NEW.stage;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'partner % cannot move from % to %: no such transition is defined for this organisation. partner_state_transition is where the legal moves are recorded, and it is the authority — not application code.',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t.requires_reason INTO v_requires
    FROM public.partner_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_stage = OLD.stage
     AND t.to_stage   = NEW.stage;

  IF v_requires AND (NEW.stage_reason IS NULL OR btrim(NEW.stage_reason) = '') THEN
    RAISE EXCEPTION
      'partner % moving from % to % requires a stated reason',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who moved it. Without this, "who signed this deal off" has an answer only for the
  -- database.
  IF NEW.stage_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'partner % changed stage from % to % without naming who made the change',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_partner_transition() IS
  'Refuses a partner stage change that partner_state_transition does not declare, a declared-but-reason-requiring change with no reason, and a change with no actor. Does NOT check WHO may make the transition: authorisation is not a database concern here and is not implied by this trigger.';

REVOKE ALL ON FUNCTION public.guard_partner_transition() FROM PUBLIC;

CREATE TRIGGER partner_transition_is_legal
  BEFORE UPDATE OF stage ON partner
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_transition();

-- -----------------------------------------------------------------------------
-- CREATORS
-- -----------------------------------------------------------------------------

-- A creator IS a person (ADR-0018). This table holds only what is true of a creator AS A
-- CREATOR — the handle they publish under and the name shown — and no contact address, no
-- credential and no external identifier, because `person` and `identity` already own those
-- and two places to record an email address is how they stop agreeing.
CREATE TABLE creator_profile (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- SINGLE-COLUMN and CORRECTLY so. `person` is the org-independent identity root, so it
  -- has no org_id to compose a composite key with. Every other FK in this file is
  -- composite; this one is the deliberate exception, and the test asserts exactly one FK
  -- and that it is this one.
  person_id    uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  handle       varchar(64) NOT NULL,
  display_name varchar(200) NOT NULL,
  bio          text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT creator_profile_handle_check CHECK (handle ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT creator_profile_display_name_check CHECK (btrim(display_name) <> ''),
  -- One creator profile per person per organisation. The same human may be profiled by
  -- several organisations — that is a tenant-scoped fact about them, not part of who they
  -- are — but two profiles in one org would make "who is our creator named X" ambiguous.
  CONSTRAINT creator_profile_org_person_key UNIQUE (org_id, person_id),
  CONSTRAINT creator_profile_org_handle_key UNIQUE (org_id, handle),
  CONSTRAINT creator_profile_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX creator_profile_org_idx       ON creator_profile (org_id);
CREATE INDEX creator_profile_org_person_idx ON creator_profile (org_id, person_id);

COMMENT ON TABLE creator_profile IS
  'What a person is known as AS A CREATOR for this organisation. Not an identity: `person_id` is NOT NULL and there is deliberately no email, login or credential column, because `person` and `identity` own those (ADR-0018) and two places to record an email is how they stop agreeing.';

-- -----------------------------------------------------------------------------
-- CONTENT PIPELINE
-- -----------------------------------------------------------------------------

-- Same shape as partner_state_transition, same reasons. `published → archived` is
-- irreversible, so `archived → published` can never be declared and an archived item
-- cannot be quietly resurrected.
CREATE TABLE content_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   content_stage NOT NULL,
  to_state     content_stage NOT NULL,
  requires_reason boolean NOT NULL DEFAULT false,
  is_irreversible boolean NOT NULL DEFAULT false,
  description  varchar(300),
  CONSTRAINT content_state_transition_key UNIQUE (org_id, from_state, to_state),
  CONSTRAINT content_state_transition_no_self_check CHECK (from_state <> to_state),
  CONSTRAINT content_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX content_state_transition_org_idx ON content_state_transition (org_id);

CREATE OR REPLACE FUNCTION public.seed_content_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.content_state_transition (org_id, from_state, to_state, requires_reason, is_irreversible, description)
  VALUES
    (p_org_id, 'draft',     'review',     false, false, 'Submitted for review'),
    (p_org_id, 'draft',     'archived',   true,  false, 'Abandoned before review'),
    (p_org_id, 'review',    'approved',   false, false, 'Passed review'),
    (p_org_id, 'review',    'draft',      true,  false, 'Changes requested'),
    (p_org_id, 'review',    'archived',   true,  false, 'Rejected'),
    (p_org_id, 'approved',  'scheduled',  false, false, 'Queued for release'),
    (p_org_id, 'approved',  'draft',      true,  false, 'Pulled back for rework'),
    (p_org_id, 'approved',  'archived',   true,  false, 'Never released'),
    (p_org_id, 'scheduled', 'published',  false, true,  'Released'),
    (p_org_id, 'scheduled', 'approved',   true,  false, 'Un-scheduled'),
    (p_org_id, 'scheduled', 'archived',   true,  false, 'Cancelled before release'),
    (p_org_id, 'published', 'archived',   false, true,  'Taken down'),
    (p_org_id, 'published', 'draft',      true,  false, 'Rework after publication')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_content_state_transition(uuid) IS
  'Seeds an organisation''s legal content moves. `scheduled → published` and `published → archived` are irreversible, so an item can be un-scheduled before release but never resurrected after it has been taken down.';

REVOKE ALL ON FUNCTION public.seed_content_state_transition(uuid) FROM PUBLIC;

CREATE TRIGGER content_state_transition_is_one_way
  BEFORE INSERT OR UPDATE OF from_state, to_state, is_irreversible ON content_state_transition
  FOR EACH ROW EXECUTE FUNCTION public.guard_content_transition_irreversibility();

CREATE TABLE content_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- COMPOSITE. A content item belongs to a creator profile in THIS organisation, and the
  -- composite FK is what makes a cross-tenant reference unexpressible rather than merely
  -- discouraged (ADR-0011).
  creator_id  uuid NOT NULL,
  title       varchar(200) NOT NULL,
  body        text NOT NULL,
  state       content_stage NOT NULL DEFAULT 'draft',
  state_reason varchar(400),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  state_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN IT WAS PLANNED FOR, and WHEN IT ACTUALLY WENT OUT. Both INSTANTS, both supplied
  -- by the caller and neither defaulted: a default would be a fabricated instant, which
  -- is precisely the class of claim ADR-0019 exists to stop storing.
  scheduled_for timestamptz,
  published_at  timestamptz,
  -- WHERE THE BYTES ARE. Required before publication — see the guard below.
  storage_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT content_item_creator_fk
    FOREIGN KEY (org_id, creator_id) REFERENCES creator_profile (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT content_item_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT content_item_body_check CHECK (btrim(body) <> ''),
  CONSTRAINT content_item_storage_ref_check CHECK (storage_ref IS NULL OR btrim(storage_ref) <> ''),
  CONSTRAINT content_item_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX content_item_org_idx          ON content_item (org_id);
CREATE INDEX content_item_org_creator_idx  ON content_item (org_id, creator_id);
CREATE INDEX content_item_org_state_idx    ON content_item (org_id, state);
CREATE INDEX content_item_org_scheduled_idx ON content_item (org_id, scheduled_for);

COMMENT ON TABLE content_item IS
  'One creator''s content item and where it is in the lifecycle. The state is STORED and the legal transitions are DATA in content_state_transition, enforced by trigger. Publishing requires a storage_ref and a supplied published_at, so a published row always names something to look at and the instant it went out.';

-- The content state machine, plus the one content-specific rule: a published item must
-- name what was published and when.
--
-- The publication rule is the shape of every other guard in this file — a claim the
-- database can contradict. A `published` row with no `storage_ref` says something is live
-- while naming nothing, and a `published_at` that DEFAULTED to now() would be an invented
-- instant. Both are refused, and the legal path is to supply them.
CREATE OR REPLACE FUNCTION public.guard_content_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.content_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'content item % cannot move from % to %: no such transition is defined for this organisation. content_state_transition is the authority — not application code.',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t.requires_reason INTO v_requires
    FROM public.content_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF v_requires AND (NEW.state_reason IS NULL OR btrim(NEW.state_reason) = '') THEN
    RAISE EXCEPTION
      'content item % moving from % to % requires a stated reason',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'content item % changed state from % to % without naming who made the change',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE PUBLICATION RULE. Both halves are required, and neither is defaulted.
  IF NEW.state = 'published' THEN
    IF NEW.storage_ref IS NULL OR btrim(NEW.storage_ref) = '' THEN
      RAISE EXCEPTION
        'content item % cannot be published with no storage_ref: a published row that names nothing is a claim the database cannot check',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.published_at IS NULL THEN
      RAISE EXCEPTION
        'content item % cannot be published with no published_at: the publication instant is supplied by the caller, never defaulted, because a default is an invented instant',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- "Scheduled for" a moment that has already passed is not a schedule.
  IF NEW.state = 'scheduled' THEN
    IF NEW.scheduled_for IS NULL THEN
      RAISE EXCEPTION
        'content item % cannot be scheduled with no scheduled_for instant', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.scheduled_for <= now() THEN
      RAISE EXCEPTION
        'content item % cannot be scheduled for an instant that has already passed', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_content_transition() IS
  'Refuses an undeclared content state change, a reason-requiring change with no reason, a change with no actor, a publication with no storage_ref or no supplied published_at, and a scheduling for an instant that has already passed. Does NOT check WHO may make the transition.';

REVOKE ALL ON FUNCTION public.guard_content_transition() FROM PUBLIC;

CREATE TRIGGER content_item_transition_is_legal
  BEFORE UPDATE OF state ON content_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_content_transition();

-- -----------------------------------------------------------------------------
-- INVOICING
-- -----------------------------------------------------------------------------

-- `ledger_journal` is referenced COMPOSITELY, so an invoice settling against another
-- tenant's journal is unexpressible rather than merely refused by a check.
CREATE TABLE invoice (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL,
  -- THE DOCUMENT NUMBER, as a stable name for the invoice rather than a row of facts. It
  -- is UNIQUE per organisation, so "invoice INV-2026-001" has exactly one referent — the
  -- same reasoning as `contract_version.version_no` in 0008.
  invoice_number varchar(64) NOT NULL,
  currency     varchar(3) NOT NULL,
  -- DERIVED, AND CONSTRAINED. `assert_invoice_balanced` recomputes this from the lines at
  -- COMMIT and refuses any invoice whose total disagrees with them. A supplied total that
  -- the lines do not support is how an organisation bills one number and accounts for
  -- another, and the difference is only ever found by a human, late.
  total_amount numeric(18,4) NOT NULL,
  state        invoice_state NOT NULL DEFAULT 'draft',
  issued_at    timestamptz,
  due_at       timestamptz,
  -- THE JOURNAL THAT DISCHARGES THIS IN THE BOOKS. Required before `paid`: "paid" with
  -- nothing in the ledger is the invoice-domain version of a hardcoded confidence, a claim
  -- the database cannot contradict.
  settled_journal_id uuid,
  external_ref varchar(120),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT invoice_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES partner (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_settlement_fk
    FOREIGN KEY (org_id, settled_journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_total_check CHECK (total_amount >= 0),
  CONSTRAINT invoice_number_check CHECK (btrim(invoice_number) <> ''),
  CONSTRAINT invoice_window_check CHECK (due_at IS NULL OR issued_at IS NULL OR due_at > issued_at),
  -- An issued invoice has an issue instant; a draft does not need one. Bound so the two
  -- states cannot be asserted independently of each other.
  CONSTRAINT invoice_issued_at_binding_check CHECK (state = 'draft' OR issued_at IS NOT NULL),
  -- Paid names the books. Void names why.
  CONSTRAINT invoice_settlement_binding_check CHECK (state <> 'paid' OR settled_journal_id IS NOT NULL),
  CONSTRAINT invoice_org_number_key UNIQUE (org_id, invoice_number),
  CONSTRAINT invoice_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX invoice_org_idx          ON invoice (org_id);
CREATE INDEX invoice_org_partner_idx  ON invoice (org_id, partner_id);
CREATE INDEX invoice_org_state_idx    ON invoice (org_id, state);
CREATE INDEX invoice_org_due_idx      ON invoice (org_id, due_at);

-- A charge. `amount > 0` for 0004's reason: a zero line is a comment wearing a costume.
-- A credit note is expressed by a reversal invoice, not by a negative line, so that
-- "what did we bill" is a sum of positive obligations rather than an arithmetic accident.
CREATE TABLE invoice_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL,
  line_no      integer NOT NULL,
  description  varchar(300) NOT NULL,
  amount       numeric(18,4) NOT NULL,
  -- The line carries its own currency so it is self-describing, and the guard below
  -- refuses a line that disagrees with its header — an invoice that balances across two
  -- currencies is a conversion performed at no rate by nobody, recorded nowhere.
  currency     varchar(3) NOT NULL,
  -- WHICH OBLIGATION THIS CHARGES FOR, when it charges for one. Nullable because an
  -- invoice may bundle a one-off fee that owes nothing; when set, the composite FK makes a
  -- cross-tenant reference unexpressible.
  obligation_part_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_invoice_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoice (org_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_line_obligation_part_fk
    FOREIGN KEY (org_id, obligation_part_id)
    REFERENCES contract_obligation_part (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_line_no_check CHECK (line_no >= 1),
  CONSTRAINT invoice_line_amount_check CHECK (amount > 0),
  CONSTRAINT invoice_line_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_line_description_check CHECK (btrim(description) <> ''),
  -- One line number per invoice, so the invoice reads back in the order it was written.
  CONSTRAINT invoice_line_org_invoice_no_key UNIQUE (org_id, invoice_id, line_no),
  CONSTRAINT invoice_line_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX invoice_line_org_idx        ON invoice_line (org_id);
CREATE INDEX invoice_line_org_invoice_idx ON invoice_line (org_id, invoice_id);

COMMENT ON TABLE invoice IS
  'An invoice to a partner. `total_amount` is DERIVED from invoice_line and constrained against it at COMMIT — an invoice whose total disagrees with its lines is refused. `paid` requires a settlement journal in this tenant''s ledger, so the claim is backed by double entry (ADR-0003, and 0004''s reconciliation rule).';

-- THE GUARD that makes the total a constraint rather than a column.
--
-- Four conditions, all needed, mirroring `assert_journal_balanced` in 0004 for the same
-- reason — a money figure that can be stated two ways is a figure nobody trusts:
--
--   1. total_amount = the sum of the lines. COALESCE handles the zero-line invoice,
--      whose total must therefore be zero rather than absent.
--   2. every line carries the header's currency.
--   3. an invoice that is not a draft has at least one line, because a zero-line invoice
--      that has been ISSUED is a document nobody asked for and nobody owes.
--   4. a paid invoice names a settlement journal in this organisation's currency, checked
--      here rather than left to the FK alone — the FK proves the journal is in the tenant,
--      and only this proves the currency agrees.
--
-- DEFERRABLE, because the only legal order is to write the header and then the lines:
-- an IMMEDIATE trigger would judge the header against zero lines and reject every correct
-- invoice.
CREATE OR REPLACE FUNCTION public.assert_invoice_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice_id uuid;
  v_total      numeric(18,4);
  v_stored     numeric(18,4);
  v_currency   varchar(3);
  v_stored_currency varchar(3);
  v_state      public.invoice_state;
  v_journal_currency varchar(3);
  v_lines      integer;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN
    v_invoice_id := NEW.id;
  ELSE
    v_invoice_id := NEW.invoice_id;
  END IF;

  SELECT i.total_amount, i.currency, i.state, i.settled_journal_id
    INTO v_stored, v_currency, v_state, v_journal_currency
    FROM public.invoice i
   WHERE i.id = v_invoice_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(l.amount), 0)::numeric(18,4), count(*)::integer,
         min(l.currency)
    INTO v_total, v_lines, v_stored_currency
    FROM public.invoice_line l
   WHERE l.invoice_id = v_invoice_id;

  IF v_stored <> v_total THEN
    RAISE EXCEPTION
      'invoice % states a total of % but its lines sum to %; an invoice whose total disagrees with its lines is refused rather than corrected, because a caller who can choose the figure can choose a wrong figure',
      v_invoice_id, v_stored, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invoice_line l
     WHERE l.invoice_id = v_invoice_id
       AND l.currency IS DISTINCT FROM v_currency
  ) THEN
    RAISE EXCEPTION
      'invoice % is in % but carries a line in another currency; a conversion performed at no rate by nobody is not a reconciliation',
      v_invoice_id, v_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_state <> 'draft' AND v_lines = 0 THEN
    RAISE EXCEPTION
      'invoice % is % with no lines at all; a document nobody was sent and nobody owes is not an invoice',
      v_invoice_id, v_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_state = 'paid' AND v_journal_currency IS NOT NULL THEN
    SELECT j.currency INTO v_stored_currency
      FROM public.ledger_journal j
     WHERE j.id = v_journal_currency;

    IF v_stored_currency IS DISTINCT FROM v_currency THEN
      RAISE EXCEPTION
        'invoice % is settled in % by a journal in %',
        v_invoice_id, v_currency, v_stored_currency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_invoice_balanced() IS
  'Refuses a COMMIT in which an invoice''s stated total differs from the sum of its lines, in which a line carries another currency, in which a non-draft invoice has no lines, or in which a paid invoice is settled by a journal in another currency. Deferred to COMMIT, because the header must be written before the lines exist.';

REVOKE ALL ON FUNCTION public.assert_invoice_balanced() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER invoice_total_must_match_lines
  AFTER INSERT ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_invoice_balanced();

CREATE CONSTRAINT TRIGGER invoice_line_must_match_total
  AFTER INSERT ON invoice_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_invoice_balanced();

-- -----------------------------------------------------------------------------
-- THE PUBLIC SURFACE
-- -----------------------------------------------------------------------------

-- Read the header of this file before changing anything here. The decision is stated
-- there: this is the ONE surface read with no tenant filter, and it is safe because
-- everything on it was vetted as publishable at write time — not because a policy is
-- remembered.

-- THE PUBLIC READ ROLE. NOLOGIN, NOSUPERUSER, NOBYPASSRLS.
--
-- NOBYPASSRLS is asserted by the test, because a public read role that could bypass RLS
-- would make the absence of a tenant policy here irrelevant: it would also be able to read
-- past every policy in the schema, and the whole argument for this table being safe would
-- collapse.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_public') THEN
    CREATE ROLE raptor_public NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- The projection. Seven columns, and the absence of the others is the design:
--
--   NO person_id        a public page does not know who made the content
--   NO creator_id       ...and not which internal profile it came from
--   NO stage / reason   the editorial pipeline is not public
--   NO obligation id    and therefore nothing about what was owed
--   NO amount / invoice nothing about money, ever
--   NO partner id       ...and nothing about who the contract was with
--
-- What it DOES carry is org_id, and that is not a leak: the public read joins on it
-- throughout and selects one organisation's rows by its own unique slug. The tenant
-- boundary here is the slug, and the join makes crossing it unexpressible rather than
-- filtered.
--
-- NO ROW LEVEL SECURITY, deliberately. Adding a policy here would hide the public site,
-- which is the opposite of what it is for. The table's safety comes from its COLUMNS and
-- from its single writer, not from a predicate — and the test asserts both.
CREATE TABLE public_site_publication (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Which item this is, so the projection can be traced back. NOT a foreign key: this
  -- table outlives nothing, but the reference must not become a JOIN for a reader to
  -- follow, and a FK to a tenant table would invite exactly that.
  content_item_id uuid NOT NULL,
  creator_handle  varchar(64) NOT NULL,
  title           varchar(200) NOT NULL,
  body            text NOT NULL,
  published_at    timestamptz NOT NULL,
  CONSTRAINT public_site_publication_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT public_site_publication_body_check CHECK (btrim(body) <> ''),
  -- One public row per content item, so a page has one answer for what an item says.
  CONSTRAINT public_site_publication_item_key UNIQUE (org_id, content_item_id),
  CONSTRAINT public_site_publication_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX public_site_publication_org_idx ON public_site_publication (org_id, published_at);

COMMENT ON TABLE public_site_publication IS
  'The public projection of published content, materialised at publish time. The ONLY table read without a tenant filter, and it carries NO RLS policy on purpose — its safety is structural: seven vetted columns, no person, no money, no obligation, no partner, and a single session-scoped writer. A test asserts the column list, so a future column is a failing test rather than a silent leak.';

-- THE ORGANISATION'S PUBLIC FACE. Three columns out of `organization`, exposed as a view so
-- the public role can be granted THIS and not the table. `organization` has no RLS policy
-- in 0001 (it is the tenant root), so a grant on the table itself would expose
-- `legal_name`, `data_region`, `fiscal_year_start_month` and everything else to an
-- anonymous reader. The view is the narrowing.
CREATE VIEW public_site_org AS
SELECT id, slug, display_name, status
  FROM organization;

COMMENT ON VIEW public_site_org IS
  'The three organisation columns a public page may read. A view rather than a grant on `organization`, so the public role never sees legal_name, data_region or fiscal settings.';

-- THE PUBLISHER. The single writer of public_site_publication.
--
-- SECURITY DEFINER, and the elevation is deliberately narrow: the function takes ONE
-- argument, an obligation-free content item id, and resolves the organisation from
-- `current_org_id()` — never from a parameter (ADR-0011 rule 3). An unset context is a
-- refusal, not a default, so the whole path fails CLOSED.
--
-- Every refusal is `insufficient_privilege` rather than "not found", because ADR-0011
-- rule 4 requires cross-tenant access to be indistinguishable from absence: a caller must
-- not be able to learn that another tenant's content item exists by being told it cannot
-- publish it.
CREATE OR REPLACE FUNCTION public.publish_content_to_public_site(p_content_item_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid := public.current_org_id();
  v_item   record;
  v_id     uuid;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION
      'no organisation in the session context; refusing to publish'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT c.id, c.title, c.body, c.published_at, c.state, c.archived_at, p.handle
    INTO v_item
    FROM public.content_item c
    JOIN public.creator_profile p
      ON p.org_id = c.org_id AND p.id = c.creator_id
   WHERE c.org_id = v_org_id
     AND c.id     = p_content_item_id;

  -- Not found and "belongs to somebody else" are the SAME refusal, on purpose.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'content item % is not publishable in the current organisation', p_content_item_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_item.archived_at IS NOT NULL OR v_item.state <> 'published' THEN
    RAISE EXCEPTION
      'content item % is in state ''%''; only published content may be put on the public site, or the public site becomes a preview channel for work that was not released',
      v_item.id, v_item.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_item.published_at IS NULL THEN
    RAISE EXCEPTION
      'content item % has no published_at; a public row with no publication instant says something is live without saying when',
      v_item.id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.public_site_publication
    (org_id, content_item_id, creator_handle, title, body, published_at)
  VALUES
    (v_org_id, v_item.id, v_item.handle, v_item.title, v_item.body, v_item.published_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

COMMENT ON FUNCTION public.publish_content_to_public_site(uuid) IS
  'The ONLY writer of public_site_publication. Takes a content item id and nothing else — the organisation comes from the session and an unset context fails closed. Refuses a cross-tenant id with insufficient_privilege, not "not found", so a refusal cannot confirm that the row exists (ADR-0011 rule 4).';

REVOKE ALL ON FUNCTION public.publish_content_to_public_site(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_content_to_public_site(uuid) TO raptor_app;

-- THE PUBLIC READ.
--
-- SECURITY INVOKER, and this is the point of the whole section: there is no elevation to
-- misuse. It reads `public_site_publication` (no RLS) and `public_site_org` (a view over
-- `organization`), joins on `org_id` throughout, and every table it touches is one the
-- caller may already read.
--
-- It takes a SLUG and never an org id, which is what makes the boundary structural rather
-- than conventional: `organization.slug` is UNIQUE, so exactly one organisation can match,
-- and the answer cannot be another tenant's page however the caller phrases the request.
--
-- An organisation that is not ACTIVE serves nothing. Its content stays perfectly readable
-- by the tenant that owns it — going public-dark is a visibility decision, not a deletion,
-- and conflating the two would turn a suspension into data loss.
--
-- NO LIMIT, for the reason `person_document_expiry_status` gives: a silently capped page
-- that presents itself as the whole is the ADR-0019 defect in a new surface.
CREATE OR REPLACE FUNCTION public.public_site_content(p_slug text)
RETURNS TABLE (
  org_slug        varchar(64),
  org_display_name varchar(200),
  title           varchar(200),
  body            text,
  creator_handle  varchar(64),
  published_at    timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT o.slug,
         o.display_name,
         p.title,
         p.body,
         p.creator_handle,
         p.published_at
    FROM public.public_site_publication p
    JOIN public.public_site_org o
      ON o.id    = p.org_id
     AND o.status = 'active'
   WHERE o.slug = p_slug
   ORDER BY p.published_at DESC, p.id
$$;

COMMENT ON FUNCTION public.public_site_content(text) IS
  'Published content for one organisation, addressed by its UNIQUE slug. SECURITY INVOKER: it reads only the public projection and a three-column organisation view, so there is no RLS elevation to misuse and no private table in its body. Returns nothing for an organisation that is not active.';

REVOKE ALL ON FUNCTION public.public_site_content(text) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- SEEDING THE STATE MACHINES AT ORGANISATION CREATION
-- -----------------------------------------------------------------------------

-- Fired when an organisation is created, so no organisation can exist without a partner
-- machine or a content machine, and no record can be written into an organisation whose
-- tables are empty.
--
-- Empty-means-nothing-legal is the safe direction: an organisation whose seed failed
-- refuses every stage change rather than accepting every one. 0008 does this for the HR
-- machine and this trigger is its sibling — a second AFTER INSERT trigger on
-- `organization`, which is why 0008's trigger and this one coexist rather than being
-- merged into an edit to an applied migration.
CREATE OR REPLACE FUNCTION public.on_organization_created_commercial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_partner_state_transition(NEW.id);
  PERFORM public.seed_content_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created_commercial() IS
  'Seeds the partner and content state machines for a new organisation, so no organisation can exist without one and every record is judged against a populated transition table.';

REVOKE ALL ON FUNCTION public.on_organization_created_commercial() FROM PUBLIC;

CREATE TRIGGER organization_seeds_commercial_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created_commercial();

-- -----------------------------------------------------------------------------
-- APPEND-ONLY
-- -----------------------------------------------------------------------------

-- Two independent mechanisms, deliberately redundant and failing in opposite directions,
-- exactly as 0004 and 0008 do. The GRANT denies the application role the operation; the
-- trigger denies it to EVERYONE including the schema owner running a migration by hand.
-- Either alone leaves a path open — a privilege grant silently widened later, or an
-- operator with psql.
--
-- `insufficient_privilege` (42501) for both, so a caller sees "you may not do this"
-- whichever one refused, which is the truth.
CREATE OR REPLACE FUNCTION public.deny_commercial_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted; record the change as a new row',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.deny_commercial_append_only_mutation() IS
  'Blocks UPDATE and DELETE on the Commercial tables where the history IS the product: an evidence row, a retraction, a stock movement and a published public row. Correction is a new row, never an edit.';

REVOKE ALL ON FUNCTION public.deny_commercial_append_only_mutation() FROM PUBLIC;

-- Evidence. The headline case: a row a sponsor disputes must say what it said forever, and
-- the only honest correction is a retraction that says who retracted it and why.
CREATE TRIGGER obligation_evidence_append_only
  BEFORE UPDATE OR DELETE ON obligation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- The retraction, for the same reason `acceptance_withdrawal` is append-only in 0008: the
-- row that records that a claim was withdrawn must not itself be withdrawable, or "was
-- this ever retracted" becomes unanswerable.
CREATE TRIGGER obligation_evidence_retraction_append_only
  BEFORE UPDATE OR DELETE ON obligation_evidence_retraction
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- A stock movement is a fact about a moment. A mistake is a reversing movement, and the
-- books still add up — which is what the archive column exists to achieve, achieved
-- without a column that could never be set.
CREATE TRIGGER inventory_movement_append_only
  BEFORE UPDATE OR DELETE ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- A published public row. A page that can be silently edited after the fact is a claim
-- nobody can check; the correction is to republish, and the history of what was said is
-- what the projection is for.
CREATE TRIGGER public_site_publication_append_only
  BEFORE UPDATE OR DELETE ON public_site_publication
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------

-- Enabled AND forced, with the tenant predicate as the WHOLE policy and no IS NULL escape,
-- so an unset tenant context hides every row rather than exposing them (ADR-0015).
--
-- `public_site_publication` is NOT in this list, and that is the one deliberate exception
-- in the file. It is the public surface; a tenant predicate there would hide it. Its
-- safety is structural — seven vetted columns and a single session-scoped writer — and
-- `commercial.isolation.test.ts` asserts both facts, so the exception cannot quietly become
-- an oversight.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'partner','partner_state_transition',
    'contract_obligation','contract_obligation_part',
    'obligation_evidence','obligation_evidence_retraction',
    'inventory_item','inventory_movement',
    'creator_profile','content_item','content_state_transition',
    'invoice','invoice_line'
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

-- -----------------------------------------------------------------------------
-- PRIVILEGES
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables: SELECT, INSERT and UPDATE, and NO DELETE. These are the tables with a
-- working document in them — a draft obligation, an item still being written, a partner
-- being worked. The guards above are what stop UPDATE being used for anything else.
GRANT SELECT, INSERT, UPDATE ON
  partner, partner_state_transition,
  contract_obligation, contract_obligation_part,
  inventory_item,
  creator_profile, content_item, content_state_transition,
  invoice, invoice_line
TO raptor_app;

-- The transition tables get NO INSERT and NO UPDATE from the application role: they are
-- governance data, seeded when the organisation is created. An organisation editing its
-- own legal lifecycle from a request handler is the "a stage table the app role can
-- rewrite is not a state machine" failure, and 0008 makes the same argument about
-- `hr_state_transition`. Only a migration or an operator changes them.
REVOKE INSERT, UPDATE, DELETE ON
  partner_state_transition, content_state_transition
FROM raptor_app;

-- Append-only tables: SELECT and INSERT only, and nothing else. Stated as an explicit
-- REVOKE as well as an absent GRANT, so a later migration that widens a grant cannot
-- accidentally hand back an UPDATE by omission.
GRANT SELECT, INSERT ON
  obligation_evidence, obligation_evidence_retraction, inventory_movement
TO raptor_app;

REVOKE UPDATE, DELETE ON
  obligation_evidence, obligation_evidence_retraction, inventory_movement
FROM raptor_app;

-- No hard deletes anywhere in this domain.
REVOKE DELETE ON
  partner, partner_state_transition,
  contract_obligation, contract_obligation_part,
  inventory_item, creator_profile, content_item, content_state_transition,
  invoice, invoice_line
FROM raptor_app;

-- The public read role gets EXACTLY TWO things, and the test asserts this grant list
-- column by column rather than trusting the comment here:
--
--   SELECT on public_site_publication   the vetted projection
--   SELECT on public_site_org           three organisation columns and no more
--
-- It gets NO grant on `organization`, on `person`, or on any tenant table — so an
-- anonymous page render cannot reach a person, an invoice or an obligation, and cannot
-- reach the organisation's own private fields either.
GRANT USAGE ON SCHEMA public TO raptor_public;
GRANT SELECT ON public.public_site_publication, public.public_site_org TO raptor_public;
GRANT EXECUTE ON FUNCTION public.public_site_content(text) TO raptor_public;

REVOKE ALL ON TABLE public.public_site_publication FROM PUBLIC;
REVOKE ALL ON TABLE public.public_site_org FROM PUBLIC;

-- The reporting and derivation functions. PUBLIC's automatic EXECUTE is taken back from
-- every one of them, so a role with no grants on the tables cannot reach the logic through
-- a function.
REVOKE ALL ON FUNCTION public.obligation_part_supported_quantity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_part_discharge_status(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_derived_state_in_org(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_derived_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_discharge_report(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_obligation_part_fulfilment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_obligation_discharge_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_inventory_window_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_inventory_not_oversold() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_partner_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_content_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_irreversible_reverse(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_invoice_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created_commercial() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_commercial_append_only_mutation() FROM PUBLIC;

-- The functions the application actually calls. The pure derivations and the report are
-- here; the guard and seeding functions are NOT, because a role that can call a guard
-- directly has no use for it — they are reachable only through a write.
--
-- `obligation_part_supported_quantity` and `obligation_part_discharge_status` are granted
-- because `obligation_discharge_report` is SECURITY INVOKER: it runs as its caller, so
-- every function it calls has to be executable BY that caller or the report is unusable
-- for exactly the role that is supposed to read it. Granting them widens nothing — they
-- are pure reads that return a count and a status string, and neither can read a row the
-- caller's own policies would hide, because the caller must already be able to SELECT the
-- evidence tables to have been given anything.
GRANT EXECUTE ON FUNCTION
  public.obligation_derived_state(uuid),
  public.obligation_derived_state_in_org(uuid, uuid),
  public.obligation_discharge_report(uuid),
  public.obligation_part_supported_quantity(uuid, uuid),
  public.obligation_part_discharge_status(uuid, uuid),
  public.publish_content_to_public_site(uuid)
TO raptor_app;

-- RLS is worthless to a role that can switch it off. Restated at the end of the file, as
-- 0001, 0002, 0004, 0005, 0006, 0007 and 0008 each do.
ALTER ROLE raptor_app NOBYPASSRLS;
ALTER ROLE raptor_app NOSUPERUSER;
ALTER ROLE raptor_public NOBYPASSRLS;
ALTER ROLE raptor_public NOSUPERUSER;

COMMIT;