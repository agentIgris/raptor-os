-- =============================================================================
-- packages/db/migrations/0008_people.sql
--
-- The PEOPLE bounded context: contracts, provable acceptance, compensation, the HR
-- lifecycle, documents with expiry, and minors/consent.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- -------------------------------------------
-- An esports organisation's most expensive disputes are "I never signed that" and
-- "that was not the version I signed". Both are answered the same way: by evidence
-- rather than by assertion. So every property below is enforced BY THE DATABASE, and
-- each is asserted by a named test in `src/people.isolation.test.ts`:
--
--   1. A contract document is immutable once any version has been accepted.
--   2. Every version carries a content hash COMPUTED BY THE DATABASE, and an INSERT
--      whose stored hash disagrees with that computation is refused.
--   3. Acceptance names a specific version. Accepting N never accepts N+1.
--   4. Acceptance is append-only: no UPDATE, no DELETE.
--   5. Withdrawal is a separate append-only record, never a mutation.
--
-- Property 2 is the one that is easy to fake. A hash column with a CHECK on its
-- SHAPE is decorative — the writer supplies 64 hex characters and the database has
-- no idea whether they describe the document beside them. So the hash here is not a
-- value the database accepts, it is a value the database RECOMPUTES from the stored
-- content and refuses to disagree with. A claim the database cannot contradict is
-- not evidence, and this file refuses to store one.
--
-- WHAT IS EXTENDED RATHER THAN DUPLICATED
-- ---------------------------------------
-- `0001_tenancy.sql` already created `person`, `person_profile`, `consent_record`
-- and `guardian_consent`. None of them is recreated here. The corrections land in
-- this file rather than as an edit to 0001, because an applied migration is never
-- rewritten (0003, 0005, 0006 and 0007 are the precedents):
--
--   person.birth_date          ADD COLUMN. A person's date of birth belongs to the
--                              person, not to an organisation: one human is the
--                              same age everywhere, and ADR-0018 makes `person` the
--                              identity root that outlives every auth provider.
--
--   guardian_consent           The 0001 shape is a global per-person flag — no
--                              organisation, no engagement, no relationship, and a
--                              `revoked_at` column on a table that must be
--                              append-only (a revocation column that can never be
--                              written is a permanent lie). It is corrected into an
--                              engagement-scoped, organisation-scoped, append-only
--                              consent record. `revoked_at` is DROPPED and replaced
--                              by `guardian_consent_revocation`.
--
-- WHY `consent_record` IS LEFT ALONE
-- ----------------------------------
-- It records consent to data processing, which is a different question from consent
-- to be engaged. A minor's ability to consent to data processing is a jurisdiction-
-- specific legal question this schema has no standing to answer, and inventing an
-- answer would be the ADR-0016 failure mode: taking a noun out of a narrative and
-- treating it as a specification. The rule this file enforces is the one the domain
-- turns on: a minor cannot be ENGAGED without a guardian who consented to that
-- specific engagement.
--
-- WHERE THE LIMIT OF THE DATABASE IS, STATED PLAINLY
-- --------------------------------------------------
-- Two things are NOT provable here, and pretending otherwise would be the same
-- defect the rest of this file exists to prevent.
--
--   * A `birth_date` of NULL does NOT mean "adult". It means unknown, and
--     `majority_status()` returns 'unknown' for it. The minor-engagement guard fires
--     only on a KNOWN minor, because most real players have no recorded date of birth
--     and refusing every one of them would be a decision this schema has no basis
--     for. Where the law genuinely requires proof of age,
--     `engagement.is_age_restricted` requires a recorded birth date — that guard IS
--     strict. The residual gap (a minor with no birth date engaged under a
--     non-age-restricted engagement) is a gap in the DATA, not in the constraint.
--     It is named here rather than hidden.
--
--   * The application may still pass the wrong `person_id`, the wrong `valid_from`,
--     or the wrong `is_age_restricted`. No schema can know which person a caller
--     meant. What the database guarantees is that whatever the caller asserts is
--     CONSISTENT and EVIDENCED: no minor is engaged without an engagement-scoped
--     guardian consent, no accepted document can change, and no acceptance exists
--     without the hash of the exact text it accepted.
--
-- TENANCY
-- -------
-- Identical to 0001/0002/0006/0007 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK between
-- tenant tables composite and including org_id, RLS ENABLED *and* FORCED with the
-- tenant predicate as the whole policy and no IS NULL escape (ADR-0015). `person` is
-- org-independent by design (ADR-0018) and is therefore referenced by single-column
-- foreign keys from tenant tables, exactly as `engagement.person_id` already is.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only tables
-- carry none, because on a table where UPDATE is impossible an archive column is a
-- column permanently NULL (the 0004 header states this rule; this file obeys it).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- CORRECTIVE: `person.birth_date`
-- -----------------------------------------------------------------------------
--
-- A DATE, not timestamptz, and the reasoning is the same as
-- `ledger_journal.posting_period` in 0004: a birthday is a calendar fact, not an
-- instant. Nobody is born at a particular UTC offset, and storing an instant would
-- mean "this person turned eighteen" resolves to a different day depending on the
-- reader's timezone.
--
-- It is NULLABLE on purpose. `person` is the identity root and most of its rows are
-- players the organisation has never asked for a passport from. NOT NULL here would
-- either force a fabricated date or exclude the people the product exists to manage.
-- NULL means UNKNOWN; it never means adult, and `majority_status()` is where that
-- distinction is made.
-- -----------------------------------------------------------------------------

ALTER TABLE person ADD COLUMN birth_date date;

COMMENT ON COLUMN person.birth_date IS
  'Calendar date of birth. NULL means UNKNOWN, never "adult": majority_status() returns ''unknown'' for it. A date rather than an instant because a birthday is a calendar fact, not a moment (the reasoning of ledger_journal.posting_period in 0004).';

-- -----------------------------------------------------------------------------
-- AGE OF MAJORITY — IN EXACTLY ONE PLACE
-- -----------------------------------------------------------------------------

-- Returns 'minor', 'adult' or 'unknown'. Three values rather than two, because the
-- implicit binary was "no birth date recorded therefore adult", and a binary that
-- cannot express "we do not know" is how an unknown becomes a false permission.
--
-- The threshold 18 lives HERE AND NOWHERE ELSE. It is a legal parameter that varies
-- by jurisdiction and this schema deliberately does not pretend to know which applies
-- where; what it does is make the number impossible to change in one place and leave
-- three copies in another. `people.isolation.test.ts` asserts that no table in the
-- schema stores a majority boolean, so the value cannot be frozen into a column that
-- a query could consult while bypassing this function entirely.
CREATE OR REPLACE FUNCTION public.majority_status(p_birth_date date, p_on date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_birth_date IS NULL OR p_on IS NULL THEN 'unknown'
           WHEN p_on >= (p_birth_date + INTERVAL '18 years')::date THEN 'adult'
           ELSE 'minor'
         END
$$;

COMMENT ON FUNCTION public.majority_status(date, date) IS
  'minor | adult | unknown for a birth date on a reference date. The age-of-majority threshold is stated HERE AND NOWHERE ELSE: it is a jurisdiction-specific legal parameter, and scattering it would let two parts of the product disagree about who is a child.';

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

CREATE TYPE guardian_relationship AS ENUM
  ('parent', 'legal_guardian', 'grandparent', 'sibling', 'other');

CREATE TYPE contract_kind AS ENUM
  ('employment', 'player_agreement', 'contractor', 'nda', 'sponsorship', 'talent_loan', 'other');

CREATE TYPE acceptance_method AS ENUM
  ('electronic_signature', 'in_person_witnessed', 'imported_legacy');

-- How the acceptor's identity was established at the moment of acceptance. Kept
-- separate from `identity.method` in 0001 because that table records WHICH login a
-- person HAS, and this records what was PROVED when they signed — a person may sign
-- a paper contract in a venue with no login at all (ADR-0018 explicitly permits a
-- person to exist without credentials).
CREATE TYPE acceptance_identity_method AS ENUM
  ('email_otp', 'sso', 'government_id', 'in_person_document', 'witnessed_oath');

CREATE TYPE compensation_kind AS ENUM
  ('salary', 'match_fee', 'win_bonus', 'per_diem', 'appearance_fee', 'retainer', 'other');

CREATE TYPE hr_record_state AS ENUM
  ('draft', 'offered', 'onboarding', 'active', 'leave', 'suspended', 'notice', 'terminated', 'offboarded');

CREATE TYPE person_document_kind AS ENUM
  ('identity', 'right_to_work', 'tax_form', 'contract', 'bank_details', 'medical', 'background_check', 'other');

-- -----------------------------------------------------------------------------
-- CORRECTIVE: `guardian_consent`
--
-- The 0001 shape, and the three reasons it cannot stand:
--
--   * It has no org_id, so consent given to one organisation silently authorised
--     every other one. A guardian who agreed to a roster spot in Org A had agreed to
--     nothing in Org B, and the schema could not tell the difference.
--   * It has no engagement_id, so it is a GLOBAL FLAG: "this minor's guardian said
--     yes, somewhere, at some point, to something". A consent not bound to the thing
--     consented to is not consent, it is a note.
--   * It carries `revoked_at` on a table that must be append-only. A revocation
--     column whose UPDATE is impossible is a column permanently NULL. Dropped, and
--     replaced by `guardian_consent_revocation`.
--
-- The ALTERs are staged — nullable first, NOT NULL immediately after — so that a
-- pre-existing row is MIGRATED rather than silently dropped, while a row written
-- after this migration still cannot omit the tenant, the engagement or the
-- relationship. `SET NOT NULL` with no default: a tenant cannot be invented for a
-- consent that already exists, and a migration that guessed one would attach a real
-- guardian's consent to an organisation nobody chose. Failing loudly is correct.
-- -----------------------------------------------------------------------------

ALTER TABLE guardian_consent ADD COLUMN org_id uuid REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE guardian_consent ADD COLUMN engagement_id uuid;
ALTER TABLE guardian_consent ADD COLUMN guardian_person_id uuid REFERENCES person(id) ON DELETE RESTRICT;
ALTER TABLE guardian_consent ADD COLUMN relationship guardian_relationship;

-- One organisation's consent is one organisation's business. An org cannot both grant
-- and lose sight of it.
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_org_id_id_key UNIQUE (org_id, id);

ALTER TABLE guardian_consent ALTER COLUMN org_id          SET NOT NULL;
ALTER TABLE guardian_consent ALTER COLUMN engagement_id    SET NOT NULL;
ALTER TABLE guardian_consent ALTER COLUMN relationship     SET NOT NULL;

-- A guardian cannot be the person they are guarding.
--
-- This is the hard case, and it is made IMPOSSIBLE rather than handled, because the
-- alternative — "a self-consent is allowed as long as a second guardian also signs"
-- — is worse than useless. It admits a record that names a person as the independent
-- authority consenting to their own engagement, which is exactly the unverifiable
-- claim the whole People context is built to exclude. Independence of the consenting
-- party is not a field the schema can verify; it is a condition the schema refuses to
-- represent. Whether a court accepts a guardian is a legal question this schema does
-- not answer; that the guardian is a DIFFERENT PERSON is a fact it can hold.
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_not_self_check
  CHECK (guardian_person_id IS DISTINCT FROM person_id);

-- ------------------------------------------------------------------ PROBLEM
-- `guardian_consent` in 0001 declared `person_id ... ON DELETE CASCADE`. On an
-- append-only table a CASCADE is a silent hard delete: erasing a person would erase
-- the evidence that they were ever a minor, which is the one row nobody may remove.
-- Changed to RESTRICT. (Corrective migration, not an edit to 0001.)
-- ------------------------------------------------------------------ PROBLEM
ALTER TABLE guardian_consent DROP CONSTRAINT guardian_consent_person_id_fkey;
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_person_fk
  FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE RESTRICT;

-- Revocation is a record, not a mutation. See `guardian_consent_revocation` below.
ALTER TABLE guardian_consent DROP COLUMN revoked_at;

CREATE INDEX guardian_consent_org_idx            ON guardian_consent (org_id);
CREATE INDEX guardian_consent_org_engagement_idx ON guardian_consent (org_id, engagement_id);
CREATE INDEX guardian_consent_org_person_idx     ON guardian_consent (org_id, person_id);

-- At most one live guardian consent per engagement. A second, different guardian for
-- the same engagement is refused: consent to an engagement is a fact about that
-- engagement, and two guardians "consented" to it means neither of them did.
CREATE UNIQUE INDEX guardian_consent_one_per_engagement_key
  ON guardian_consent (org_id, engagement_id);

COMMENT ON TABLE guardian_consent IS
  'One guardian''s consent to ONE engagement for ONE organisation, for a person known to be a minor on the engagement''s start date. Append-only: a withdrawal is a separate row in guardian_consent_revocation, never an UPDATE, because an UPDATE would destroy the record that consent was once given and then taken back.';

COMMENT ON COLUMN guardian_consent.guardian_person_id IS
  'The guardian as an identity this platform knows, so the consent is provable against a real party rather than a typed name. NULL is permitted only for an offline guardian, who must then be evidenced by document_asset_id — a name alone is not a party.';

-- The policy itself is created in the RLS block at the foot of this file, together
-- with every other table's, so that `guardian_consent` is not the one table whose
-- tenancy is defined somewhere else. What is asserted HERE is the FORCE, because
-- 0001 enabled RLS without forcing it and without ever writing a policy: the table
-- was enabled, which is a flag, and not isolated, which is a guarantee.

ALTER TABLE guardian_consent FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- THE CONTRACT
--
-- The agreement as a container, distinct from its versions. `contract` says WHO
-- agreed with WHOM and about WHAT; `contract_version` says what the text said at a
-- particular point. Keeping them apart is what makes "corrections are a new version"
-- expressible: a version is a fact about a moment, and a fact about a moment has no
-- UPDATE.
--
-- `contract` itself carries no content and is never accepted, so it is mutable and
-- carries `archived_at`.
-- -----------------------------------------------------------------------------

CREATE TABLE contract (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The person who is a party to this contract. NOT NULL: a contract with no party is
  -- a document, and documents are a different table with a different lifecycle.
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- The engagement this contract governs, when it governs one. Nullable because an
  -- NDA can exist before any engagement does, and requiring the reverse would make
  -- "sign an NDA before an offer" unexpressible. The composite FK makes a
  -- cross-tenant engagement reference impossible when it IS set.
  engagement_id uuid,
  kind          contract_kind NOT NULL,
  title         varchar(200) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT contract_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_org_idx          ON contract (org_id);
CREATE INDEX contract_org_person_idx   ON contract (org_id, person_id);
CREATE INDEX contract_org_engagement_idx ON contract (org_id, engagement_id);

-- -----------------------------------------------------------------------------
-- THE CONTENT HASH — COMPUTED, NOT ACCEPTED
--
-- `contract_content_hash` is the single definition of what a version's content IS.
-- Everything else in this file refers to it; nothing recomputes a hash any other way.
--
-- The canonical form is LENGTH-FRAMED (`name=len:value`), the same shape 0004 uses
-- for `snapshot_hash`. Framing is not decoration: a plain concatenation lets a
-- document whose text is "ab"+"c" hash identically to one whose text is "a"+"bc", so
-- two different contracts could share a hash and the hash would prove nothing about
-- which one was signed.
--
-- IMMUTABLE and pure. It reads no table and takes no tenant parameter, so it cannot
-- be the place where the tenant sneaks in.
--
-- WHAT IS AND IS NOT IN THE HASH
-- -----------------------------
-- The identity of the contract (org, contract, version number) is IN, because "this
-- text" is only evidence about a document when it is evidence about WHICH document.
-- The signing and expiry instants are OUT, deliberately: acceptance records them on
-- the acceptance row, and the whole point of property 3 is that an acceptance points
-- at one version — so putting the instant in the hash would make every acceptance
-- need a new version, which is exactly backwards.
--
-- REPLICATED from application code: the writer MAY compute this hash ahead of time
-- (in packages/core, where ADR-0010 puts business rules) and supply it. It may also
-- supply a wrong one, and the trigger below refuses the row. Both paths produce the
-- same bytes because both are the same function over the same inputs.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.contract_content_hash(
  p_contract_id     uuid,
  p_version_no      integer,
  p_title           text,
  p_document_body   text
)
RETURNS char(64)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(
    sha256(convert_to(
      'contract_id=' || length(p_contract_id::text) || ':' || p_contract_id::text || E'\n'
      || 'version_no='  || length(p_version_no::text)  || ':' || p_version_no::text  || E'\n'
      || 'title='       || length(coalesce(p_title, ''))          || ':' || coalesce(p_title, '')          || E'\n'
      || 'document_body=' || length(coalesce(p_document_body, '')) || ':' || coalesce(p_document_body, '') || E'\n',
      'utf8'
    )),
    'hex'
  )::char(64)
$$;

COMMENT ON FUNCTION public.contract_content_hash(uuid, integer, text, text) IS
  'The content hash of one contract version, computed from the version''s identity and its stored text. The single definition of what a version''s content IS: length-framed so two different documents cannot share a hash by running their text together.';

-- -----------------------------------------------------------------------------
-- CONTRACT VERSIONS
--
-- Append-only. There is no UPDATE path here at all, and no `archived_at`: a version
-- is either a draft nobody has accepted, or an accepted fact, and a fact about a
-- moment is not edited. The sealing rule below narrows the INSERT side:
--
--   * Version 1 of a fresh contract is a draft and may be written freely.
--   * Once ANY version of a contract has been accepted, no further version may be
--     written without a `supersedes_id`, and the superseding version must number
--     exactly one above the highest version so far. So a correction is a new version
--     on an existing chain, never a replacement for an accepted one.
--
-- This is property 1 expressed as an INSERT guard rather than a mutation guard,
-- because on this table there is no mutation to guard.
-- -----------------------------------------------------------------------------

CREATE TABLE contract_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL,
  version_no   integer NOT NULL,
  title        varchar(200) NOT NULL,
  -- The document itself. The hash below is a function of THIS text, so the text is
  -- the evidence and the hash is only ever a way of naming it.
  document_body text NOT NULL,
  content_hash char(64) NOT NULL,
  -- A correction names the version it replaces. The chain is the audit trail: it is
  -- what answers "which text was in force on the day the player was paid".
  supersedes_id uuid,
  -- Set when the author intended this version to be signed; it does NOT mean it was.
  -- Acceptance is a separate row and this flag cannot create one.
  is_draft     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contract_version_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE CASCADE,
  CONSTRAINT contract_version_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES contract_version (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_version_body_check CHECK (btrim(document_body) <> ''),
  CONSTRAINT contract_version_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_version_no_check CHECK (version_no >= 1),
  CONSTRAINT contract_version_hash_shape_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_version_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_version_org_idx        ON contract_version (org_id);
CREATE INDEX contract_version_org_contract_idx ON contract_version (org_id, contract_id);

-- One version number per contract. Without this, "version 2" could name two different
-- texts and an acceptance pointing at version 2 would be ambiguous — which is the
-- whole dispute this table exists to end.
CREATE UNIQUE INDEX contract_version_number_key
  ON contract_version (org_id, contract_id, version_no);

-- One successor per version: the correction history is a PATH, not a tree. A branch
-- would let two corrections claim the same predecessor and "which version replaced
-- which" would have two answers.
CREATE UNIQUE INDEX contract_version_supersedes_key
  ON contract_version (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE contract_version IS
  'One immutable version of one contract''s text. There is no UPDATE and no archived_at: a version is a fact about a moment, and a fact about a moment is not edited. Acceptance of one version never carries to another (contract_acceptance), which is why the chain matters more than the latest row.';

-- -----------------------------------------------------------------------------
-- PROPERTY 2 — THE HASH IS RECOMPUTED, NOT ACCEPTED
--
-- A BEFORE INSERT trigger, so the row never exists in a state the database would
-- refuse. `23514` (check_violation) is raised deliberately: a disagreeing hash is a
-- violated claim about the row's own contents, and the same SQLSTATE a CHECK on a
-- derived figure uses, so a caller distinguishing "the stored figure disagrees with
-- its inputs" from "some other shape error" gets the same answer here.
--
-- It covers UPDATE too. There is no UPDATE today; if a later migration adds one, this
-- trigger makes it useless to lie in it, and the absence of an UPDATE trigger becomes
-- a deliberate statement rather than an oversight.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contract_version_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_expected char(64);
BEGIN
  v_expected := public.contract_content_hash(NEW.contract_id, NEW.version_no, NEW.title, NEW.document_body);

  IF NEW.content_hash IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'contract version % (contract %, version %): content_hash % is not the hash of the content stored on this row (%); the database computes the hash, so a hash that disagrees with the text is refused',
      NEW.id, NEW.contract_id, NEW.version_no, NEW.content_hash, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_version_hash() IS
  'Recomputes the version''s content hash from its own stored text and refuses the row when the supplied hash disagrees. A hash the database merely stores is a claim; a hash the database computes is evidence.';

REVOKE ALL ON FUNCTION public.guard_contract_version_hash() FROM PUBLIC;

CREATE TRIGGER contract_version_hash_is_computed
  BEFORE INSERT OR UPDATE ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_version_hash();

-- -----------------------------------------------------------------------------
-- PROPERTY 1 — A CONTRACT IS SEALED ONCE ANY VERSION IS ACCEPTED
--
-- The rule spans three rows (the new version, the contract it belongs to, and the
-- acceptances on that contract's versions), so it is a trigger rather than a CHECK.
--
-- WHY THE SEAL IS PER-CONTRACT AND NOT PER-VERSION
-- -----------------------------------------------
-- A per-version rule would say "an accepted version cannot change" — true, and not
-- enough. The dispute is "that was not the version I signed", and the dangerous move
-- is not editing version 1 after signing it; it is REPLACING version 1 with new text
-- under the same number, so that a later read of "version 1" returns an agreement the
-- signer never saw. Sealing the whole contract on first acceptance makes the version
-- NUMBER a stable name for the text that number always had.
--
-- The insert guard therefore requires, for any version written after the contract is
-- sealed:
--
--   * a `supersedes_id` — a correction names what it corrects;
--   * that predecessor to be the contract's CURRENT head, not some ancestor of it, so
--     the chain cannot be forked at a historical version and the head stays unique;
--   * `version_no` to be exactly one above the predecessor's — the numbering is a
--     sequence, not a label the writer chooses freely.
--
-- `exclusion_violation` (23P01) rather than check_violation, matching
-- `guard_performance_supersession` in 0007: this is what a declarative constraint
-- would raise for the same shape, so moving to one on a full server is not an
-- observable change to any caller.
--
-- SECURITY DEFINER because the acceptances it reads may belong to a version the
-- caller's policies would otherwise hide — which is precisely the row a caller most
-- needs to be checked against. REVOKEd from PUBLIC immediately below, so the
-- elevation is reachable only by writing a version.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contract_version_sealing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sealed       boolean;
  v_head_id      uuid;
  v_head_no      integer;
BEGIN
  -- Is ANY version of this contract already accepted? One query, because the rule is
  -- about the contract and not about the version being written.
  SELECT EXISTS (
           SELECT 1
             FROM public.contract_acceptance a
             JOIN public.contract_version v ON v.org_id = a.org_id AND v.id = a.contract_version_id
            WHERE a.org_id = NEW.org_id
              AND v.contract_id = NEW.contract_id
         )
    INTO v_sealed;

  -- An unsealed contract is still being drafted. The very first version is untracked
  -- by definition (nothing supersedes it), which is what makes a draft editable in
  -- the only way this table permits: by adding the next version of it.
  IF NOT v_sealed THEN
    RETURN NEW;
  END IF;

  -- The head is the version nothing supersedes. There is exactly one on a well-formed
  -- chain, because contract_version_supersedes_key makes every predecessor claimed
  -- once and contract_version_number_key makes every number unique.
  SELECT v.id, v.version_no
    INTO v_head_id, v_head_no
    FROM public.contract_version v
   WHERE v.org_id      = NEW.org_id
     AND v.contract_id = NEW.contract_id
     AND NOT EXISTS (
           SELECT 1 FROM public.contract_version s
            WHERE s.org_id = NEW.org_id AND s.supersedes_id = v.id
         )
   ORDER BY v.version_no DESC
   LIMIT 1;

  IF NEW.supersedes_id IS NULL THEN
    RAISE EXCEPTION
      'contract % is sealed: version % has been accepted, so any further version must supersede the current version (% = version %) rather than exist alongside it',
      NEW.contract_id, NEW.contract_id, v_head_id, v_head_no
      USING ERRCODE = 'exclusion_violation';
  END IF;

  IF NEW.supersedes_id <> v_head_id THEN
    RAISE EXCEPTION
      'contract % is sealed: version % must supersede the current version (%), not %; a chain that forks at an old version gives "which text is current" two answers',
      NEW.contract_id, NEW.id, v_head_id, NEW.supersedes_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  IF NEW.version_no <> v_head_no + 1 THEN
    RAISE EXCEPTION
      'contract % is sealed: the next version is % (superseding version %), not %; a version number must mean one text forever',
      NEW.contract_id, v_head_no + 1, v_head_no, NEW.version_no
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_version_sealing() IS
  'Once any version of a contract has been accepted, a further version must supersede the current one and number exactly one above it. Refuses a version that would exist alongside the accepted chain, fork it at an old version, or reuse a number.';

REVOKE ALL ON FUNCTION public.guard_contract_version_sealing() FROM PUBLIC;

-- The TRIGGER for this function is created below, immediately after
-- `contract_acceptance` exists. Declaring it here would work — plpgsql resolves its
-- statements lazily — but a trigger whose body reads a table declared two hundred
-- lines further down is a reader's problem for no benefit, and moving it costs
-- nothing.

-- -----------------------------------------------------------------------------
-- ACCEPTANCE — PROPERTY 3, 4 AND 5
--
-- Append-only, and never an UPDATE of a contract. It names ONE version, records WHO
-- accepted, WHEN, and UNDER WHAT IDENTITY, and pins the hash of the text that was in
-- front of them.
--
-- WHY THE HASH IS COPIED ONTO THE ACCEPTANCE
-- -------------------------------------------
-- The version's hash is already stored, and a composite FK would reach it. The copy
-- is not redundancy for its own sake: it is the thing that makes the acceptance
-- SELF-CONTAINING evidence. A reader holding one acceptance row — which is what gets
-- exported when a contract is disputed, and what a regulator's discovery request
-- returns — can see exactly which bytes were signed without a second query that might
-- resolve differently later. And because the trigger below recomputes it from the
-- version, the copy cannot drift from the thing it copies.
--
-- `accepted_by_person_id` may not be the contract's own party signing their own
-- contract? No — it may: a person absolutely signs their own contract. What must not
-- happen is an acceptance attributed to a person who is not a party to the contract
-- at all, so the trigger checks party membership rather than forbidding self-signing.
-- -----------------------------------------------------------------------------

CREATE TABLE contract_acceptance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contract_id       uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  -- WHO accepted.
  accepted_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN, as an instant. The instant acceptance happened, not the instant the row was
  -- written, so a backfilled acceptance sorts into the day it was signed.
  accepted_at      timestamptz NOT NULL,
  -- UNDER WHAT IDENTITY: how the acceptor's identity was established at that moment.
  -- Separate from `identity` (0001), which records which login a person HAS.
  identity_method  acceptance_identity_method NOT NULL,
  -- WHAT the identity resolved to at the time — the email address that received the
  -- OTP, the document number that was shown. A method with no subject is "we checked
  -- them somehow", which is not a provable acceptance.
  identity_assertion varchar(240) NOT NULL,
  method           acceptance_method NOT NULL,
  -- The hash of the text that was accepted, pinned at the moment of acceptance.
  content_hash     char(64) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contract_acceptance_version_fk
    FOREIGN KEY (org_id, contract_version_id) REFERENCES contract_version (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_acceptance_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_acceptance_hash_shape_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_acceptance_identity_assertion_check CHECK (btrim(identity_assertion) <> ''),
  CONSTRAINT contract_acceptance_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_acceptance_org_idx        ON contract_acceptance (org_id);
CREATE INDEX contract_acceptance_org_contract_idx ON contract_acceptance (org_id, contract_id);
CREATE INDEX contract_acceptance_org_version_idx  ON contract_acceptance (org_id, contract_version_id);
CREATE INDEX contract_acceptance_org_person_idx   ON contract_acceptance (org_id, accepted_by_person_id);

-- At most ONE acceptance per version. A second acceptance of the same text is either
-- a double-click or a second signer, and in both cases "who accepted this version"
-- stops having one answer. A re-signature of corrected text is a NEW VERSION, which
-- is the entire mechanism.
CREATE UNIQUE INDEX contract_acceptance_one_per_version_key
  ON contract_acceptance (org_id, contract_version_id);

COMMENT ON TABLE contract_acceptance IS
  'One person''s acceptance of one specific version of one contract, naming the hash of the text they were shown. Append-only. Acceptance of version N is never acceptance of version N+1 — a later version is a later acceptance or it is nothing.';

-- The acceptance must name a version OF THIS CONTRACT, and the hash it pins must be
-- the hash of that version. Both would be reassuring to check and neither is
-- guaranteed by the foreign keys: a composite FK on (org_id, contract_version_id)
-- cannot know which contract the version belongs to, because contract_version's
-- identity includes its contract.
CREATE OR REPLACE FUNCTION public.guard_contract_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version_contract uuid;
  v_version_hash     char(64);
  v_party            boolean;
BEGIN
  SELECT v.contract_id, v.content_hash
    INTO v_version_contract, v_version_hash
    FROM public.contract_version v
   WHERE v.org_id = NEW.org_id
     AND v.id     = NEW.contract_version_id;

  IF v_version_contract IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION
      'acceptance % names version % which belongs to contract %, not contract %',
      NEW.id, NEW.contract_version_id, v_version_contract, NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.content_hash IS DISTINCT FROM v_version_hash THEN
    RAISE EXCEPTION
      'acceptance % pins content_hash % but version % hashes to %; an acceptance that names text other than the text it accepted is not evidence of anything',
      NEW.id, NEW.content_hash, NEW.contract_version_id, v_version_hash
      USING ERRCODE = 'check_violation';
  END IF;

  -- The acceptor must be a party to the contract. Self-signing is ordinary and
  -- legitimate; signing somebody ELSE''s contract is not an acceptance, it is a
  -- forgery with a row in the table.
  SELECT EXISTS (
           SELECT 1 FROM public.contract c
            WHERE c.org_id    = NEW.org_id
              AND c.id        = NEW.contract_id
              AND c.person_id = NEW.accepted_by_person_id
         )
    INTO v_party;

  IF NOT v_party THEN
    RAISE EXCEPTION
      'acceptance % is attributed to person %, who is not a party to contract %',
      NEW.id, NEW.accepted_by_person_id, NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_acceptance() IS
  'Refuses an acceptance that names a version of a different contract, pins a hash other than that version''s, or is attributed to somebody who is not a party to the contract.';

REVOKE ALL ON FUNCTION public.guard_contract_acceptance() FROM PUBLIC;

CREATE TRIGGER contract_acceptance_is_evidenced
  BEFORE INSERT ON contract_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_acceptance();

-- Property 1's trigger, attached now that the table it reads exists.
CREATE TRIGGER contract_version_sealed_after_acceptance
  BEFORE INSERT ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_version_sealing();

-- -----------------------------------------------------------------------------
-- PROPERTY 5 — WITHDRAWAL IS A ROW, NOT A MUTATION
--
-- A withdrawal/revocation of consent or of an acceptance is a separate append-only
-- record. The two tables below exist so that the answer to "did they withdraw?" is a
-- query over events, never a column someone flipped.
--
-- WHY THIS IS NOT A `withdrawn_at` COLUMN
-- ---------------------------------------
-- A nullable timestamp on the acceptance would make withdrawal and acceptance the
-- same kind of fact: both would be properties of one row, and a withdrawal that
-- happened would be indistinguishable from one that was asserted later by whoever
-- last wrote the row. Making it a row means the withdrawal carries its own actor, its
-- own instant and its own reason — and that the acceptance row, which is evidence
-- that someone signed, cannot be edited by the same act that undoes it.
-- -----------------------------------------------------------------------------

CREATE TABLE acceptance_withdrawal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  acceptance_id uuid NOT NULL,
  withdrawn_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  withdrawn_at  timestamptz NOT NULL,
  reason        varchar(400) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acceptance_withdrawal_acceptance_fk
    FOREIGN KEY (org_id, acceptance_id) REFERENCES contract_acceptance (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT acceptance_withdrawal_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT acceptance_withdrawal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX acceptance_withdrawal_org_idx        ON acceptance_withdrawal (org_id);
CREATE INDEX acceptance_withdrawal_org_acceptance_idx ON acceptance_withdrawal (org_id, acceptance_id);

-- One withdrawal per acceptance. A second withdrawal of the same acceptance is a
-- duplicate notification, not a second event.
CREATE UNIQUE INDEX acceptance_withdrawal_one_per_acceptance_key
  ON acceptance_withdrawal (org_id, acceptance_id);

COMMENT ON TABLE acceptance_withdrawal IS
  'One withdrawal of one acceptance. A row, not a column on contract_acceptance: the acceptance is evidence that someone signed, and the same act that undoes it must not be able to edit it.';

-- -----------------------------------------------------------------------------
-- APPEND-ONLY, ENFORCED
--
-- Two independent mechanisms, deliberately redundant and failing in opposite
-- directions, exactly as 0004 does for the money tables. The GRANT denies the
-- application role the operation; the trigger denies it to EVERYONE including the
-- schema owner running a migration by hand. Either alone leaves a path open — a
-- privilege grant silently widened later, or an operator with psql.
--
-- `insufficient_privilege` (42501) for both, so a caller sees "you may not do this"
-- whichever one refused, which is the truth.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deny_people_append_only_mutation()
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

COMMENT ON FUNCTION public.deny_people_append_only_mutation() IS
  'Blocks UPDATE and DELETE on the People tables where history is the product: a version, an acceptance, a withdrawal and a consent. Correction is a new row, never an edit.';

REVOKE ALL ON FUNCTION public.deny_people_append_only_mutation() FROM PUBLIC;

CREATE TRIGGER contract_version_append_only
  BEFORE UPDATE OR DELETE ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER contract_acceptance_append_only
  BEFORE UPDATE OR DELETE ON contract_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER acceptance_withdrawal_append_only
  BEFORE UPDATE OR DELETE ON acceptance_withdrawal
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER guardian_consent_append_only
  BEFORE UPDATE OR DELETE ON guardian_consent
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

-- The withdrawal of a guardian consent. Separated from the consent for the same
-- reason a withdrawal of an acceptance is separated from the acceptance: the row
-- that records that consent was given must not be editable by the act that takes it
-- back.
CREATE TABLE guardian_consent_withdrawal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  guardian_consent_id uuid NOT NULL,
  withdrawn_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  withdrawn_at        timestamptz NOT NULL,
  reason              varchar(400) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guardian_consent_withdrawal_consent_fk
    FOREIGN KEY (org_id, guardian_consent_id) REFERENCES guardian_consent (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_consent_withdrawal_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT guardian_consent_withdrawal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX guardian_consent_withdrawal_org_idx        ON guardian_consent_withdrawal (org_id);
CREATE INDEX guardian_consent_withdrawal_org_consent_idx ON guardian_consent_withdrawal (org_id, guardian_consent_id);

CREATE UNIQUE INDEX guardian_consent_withdrawal_one_per_consent_key
  ON guardian_consent_withdrawal (org_id, guardian_consent_id);

COMMENT ON TABLE guardian_consent_withdrawal IS
  'One withdrawal of one guardian consent. A row, not a column on guardian_consent: the consent is evidence that a guardian agreed, and the act that takes it back must not be able to edit it.';

CREATE TRIGGER guardian_consent_withdrawal_append_only
  BEFORE UPDATE OR DELETE ON guardian_consent_withdrawal
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

-- -----------------------------------------------------------------------------
-- IS A CONSENT VALID ON A GIVEN DATE
--
-- The one question the minors rules turn on, asked in one place so that the answer
-- cannot differ between the guard below and anything a screen displays.
--
-- Three ways a consent stops covering an engagement:
--
--   * it was never given for THIS engagement (the composite FK already guarantees
--     the linkage, and this is re-asserted so the function is safe to call alone);
--   * it was withdrawn (an event exists);
--   * it expired before the engagement began (expires_at is a stored instant, not a
--     flag, so "is it still valid" is arithmetic rather than an assertion).
--
-- TWO ENTRY POINTS, ONE DEFINITION, DELIBERATELY
-- ------------------------------------------------
-- `guardian_consent_covers_in_org` is the definition and it takes an explicit
-- organisation. `guardian_consent_covers` is the application-facing wrapper that
-- supplies the tenant from the session (ADR-0011 rule 3).
--
-- The split is not tidiness. The integrity trigger BELOW must call the definition,
-- not the wrapper, because a trigger firing on `engagement` already knows the row's
-- own org_id and must not consult `current_org_id()` for it. Two reasons, and the
-- second is the serious one:
--
--   * `current_org_id()` is NULL whenever `app.org_id` is unset, so a guard written
--     against it would silently permit every minor engagement whenever the write
--     came from a maintenance session, a migration, or a superuser — precisely the
--     sessions in which nobody is watching.
--   * Worse, it makes integrity depend on session state an attacker controls. A
--     session that set `app.org_id` to another tenant could change which consent
--     rows the guard reads, and the constraint would be evaluated against a tenant
--     the row does not belong to.
--
-- A constraint that can be switched off by not setting a variable is not a
-- constraint.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guardian_consent_covers_in_org(
  p_org_id uuid,
  p_person_id uuid,
  p_engagement_id uuid,
  p_from_instant timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.guardian_consent gc
      LEFT JOIN public.guardian_consent_withdrawal w
        ON w.org_id = gc.org_id AND w.guardian_consent_id = gc.id
     WHERE gc.org_id           = p_org_id
       AND gc.person_id        = p_person_id
       AND gc.engagement_id    = p_engagement_id
       -- An INSTANT comparison, not a date one. `expires_at` is the instant the
       -- consent stops covering, so the only correct test is "the engagement begins
       -- before the consent ends". Converting the engagement's start to a calendar
       -- date and back again would make the answer depend on the session's
       -- TimeZone — and the local PGlite session is not UTC, so a consent expiring
       -- at midnight could read as covering an engagement that began the previous
       -- day. Same reasoning as `person_document_expiry_status`, and for the same
       -- reason: a half-open interval on instants has no timezone in it.
       AND (gc.expires_at IS NULL OR gc.expires_at > p_from_instant)
       AND w.id IS NULL
  )
$$;

COMMENT ON FUNCTION public.guardian_consent_covers_in_org(uuid, uuid, uuid, timestamptz) IS
  'Whether a guardian''s consent covers this person for this engagement in this organisation, starting at an instant: granted, not withdrawn, and not expired by then. Takes an explicit organisation because it is the definition the integrity trigger uses, and a constraint must not depend on session state.';

CREATE OR REPLACE FUNCTION public.guardian_consent_covers(
  p_person_id uuid,
  p_engagement_id uuid,
  p_from_instant timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.guardian_consent_covers_in_org(
    public.current_org_id(), p_person_id, p_engagement_id, p_from_instant)
$$;

COMMENT ON FUNCTION public.guardian_consent_covers(uuid, uuid, timestamptz) IS
  'Whether a guardian''s consent covers this person for this engagement, starting at an instant. Takes no organisation argument — the tenant comes from the session (ADR-0011 rule 3), and an unset context fails closed.';

-- -----------------------------------------------------------------------------
-- MINORS CANNOT BE ENGAGED WITHOUT GUARDIAN CONSENT
--
-- A trigger on `engagement`, which is the actual gate. Without it, the minor rules
-- are a note next to an unguarded column — the same shape as the legacy system,
-- which recorded a guardian's name and then engaged whoever it liked.
--
-- THE THRESHOLD IS NOT SCATTERED: this reads public.majority_status() and nothing
-- else. There is no 18 here.
--
-- WHY THE REFERENCE DATE IS valid_from AND NOT now()
-- -----------------------------------------------
-- A player who is 17 today and turns 18 next month is engageable next month. Judging
-- them by the clock at insert time would refuse a contract that is correct on the day
-- it starts, and would let the same engagement be legal or illegal depending on when
-- somebody re-ran the query. `valid_from` is the instant the engagement exists, so
-- that is the date the age question is asked.
--
-- WHY THE GUARD IS DEFERRABLE AND INITIALLY DEFERRED
-- -------------------------------------------------
-- A deferrable constraint trigger, because the obvious insert order is impossible
-- otherwise: consent names an engagement (FK), so the engagement must exist first,
-- but the engagement needs consent to exist. Deferring to COMMIT lets one transaction
-- write the engagement and its consent in the order it actually happens, while still
-- refusing the COMMIT if the consent was never written. An IMMEDIATE trigger would
-- make the domain unexpressible and would be disabled by the first person who hit it.
--
-- The same deferral is what makes the reverse case work: a person whose guardian
-- withdraws consent after the engagement is written cannot have the engagement
-- retroactively un-written either (it is history), so the verdict is asked ONCE per
-- set of judged inputs and not revisited.
--
-- WHICH IS WHY THE TRIGGER LISTENS TO SPECIFIC COLUMNS
-- ------------------------------------------------------
-- `AFTER INSERT OR UPDATE OF person_id, valid_from, is_age_restricted` — and not a
-- bare `OR UPDATE`. The guard's inputs are those three columns and nothing else, so
-- those are the only changes that can change the answer.
--
-- A bare `OR UPDATE` would make the guard re-judge the WHOLE historical row every
-- time anything at all was written to it — including `valid_to`, which is how an
-- engagement is closed. The consequence is not theoretical: a guardian withdrawing
-- consent would make the existing engagement row UNWRITABLE, because closing it
-- would re-run the guard against a consent that no longer exists. History would be
-- frozen by a later event, and an org could not record that a contract ended. That is
-- precisely the "rewrite history on the strength of a later event" this section
-- exists to prevent, reached by the opposite route.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_minor_engagement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_birth date;
  v_status text;
BEGIN
  SELECT p.birth_date INTO v_birth FROM public.person p WHERE p.id = NEW.person_id;

  v_status := public.majority_status(v_birth, (NEW.valid_from AT TIME ZONE 'UTC')::date);

  -- An age-restricted engagement is the case where the law REQUIRES proof of age, so
  -- there an absent birth date is a refusal rather than an unknown. This is the strict
  -- half of the rule; the guard below is the lenient half, and the asymmetry is
  -- deliberate and is stated in the file header.
  IF NEW.is_age_restricted AND v_birth IS NULL THEN
    RAISE EXCEPTION
      'engagement % is age-restricted but person % has no recorded birth_date; an age-restricted engagement cannot be created without proof of age',
      NEW.id, NEW.person_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_status = 'minor' THEN
    -- NEW.org_id, NOT current_org_id(). See the note on guardian_consent_covers: an
    -- integrity trigger must evaluate against the row it fires on, not against
    -- whatever tenant the session happens to name.
    IF NOT public.guardian_consent_covers_in_org(NEW.org_id, NEW.person_id, NEW.id, NEW.valid_from) THEN
      RAISE EXCEPTION
        'engagement % engages person %, who is a minor on % (born %); a guardian consent for THIS engagement is required, and none is in force',
        NEW.id, NEW.person_id,
        to_char((NEW.valid_from AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'), v_birth
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.guard_minor_engagement() IS
  'Refuses a COMMIT that would engage a known minor without a guardian consent covering that exact engagement from its start instant, and refuses an age-restricted engagement for a person with no recorded birth date. Deferred, because consent names an engagement and so cannot be written first. Wired to INSERT and to changes of person_id / valid_from / is_age_restricted ONLY, so closing an engagement never re-judges it against a consent withdrawn since.';

REVOKE ALL ON FUNCTION public.guard_minor_engagement() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER engagement_minor_requires_guardian_consent
  AFTER INSERT OR UPDATE OF person_id, valid_from, is_age_restricted ON engagement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_minor_engagement();

-- -----------------------------------------------------------------------------
-- COMPENSATION
--
-- A pay figure is a contract with numbers in it, and it is disputed exactly the same
-- way: "that is not what I was signed up for". So it takes the same discipline as a
-- contract — append-only, superseded rather than edited, money as numeric(18,4)
-- beside an ISO-4217 currency (ADR-0003; never an integer minor unit, never a float).
--
-- `compensation_agreement` is the CONTAINER (who, for what engagement, what kind of
-- money); `compensation_figure` is the VERSIONED content, mirroring
-- contract/contract_version exactly. The split is the point: an agreement's identity
-- is stable, its figures move, and a dispute is always about which figure was in
-- force on a date — a question with one answer per version and no answer at all if
-- the figure lives on the mutable row.
--
-- EFFECTIVE DATING follows the convention in 0002 (`valid_from`/`valid_to`,
-- `valid_to IS NULL` meaning current, `valid_to > valid_from`): half-open, so two
-- consecutive agreements meet without overlapping and none is current twice.
-- -----------------------------------------------------------------------------

CREATE TABLE compensation_agreement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL,
  kind          compensation_kind NOT NULL,
  title         varchar(200) NOT NULL,
  currency      varchar(3) NOT NULL,
  -- ANNUAL / PERIODIC figure. What it means depends on `kind`, which is why the kind
  -- is a column and not a convention: a "salary" of 3000000 and a "per_diem" of
  -- 3000000 are not the same claim, and nothing in the number says which.
  amount        numeric(18,4) NOT NULL,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT compensation_agreement_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT compensation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Non-negative, and the bound is on the numeric SCALE as well as the sign: a pay
  -- figure that overflows numeric(18,4) fails here with a readable error rather than
  -- later as a numeric_value_out_of_range in a payroll query nobody was looking at.
  CONSTRAINT compensation_amount_check CHECK (amount >= 0 AND amount < 1000000000000),
  CONSTRAINT compensation_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT compensation_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT compensation_agreement_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX compensation_agreement_org_idx          ON compensation_agreement (org_id);
CREATE INDEX compensation_agreement_org_person_idx   ON compensation_agreement (org_id, person_id);
CREATE INDEX compensation_agreement_org_engagement_idx ON compensation_agreement (org_id, engagement_id);
CREATE INDEX compensation_agreement_org_valid_idx    ON compensation_agreement (org_id, valid_from);

-- At most one CURRENT agreement per (engagement, kind). The partial form rather than
-- a bare UNIQUE because superseding is legitimate and two live agreements are not:
-- without this, "what does this player currently earn" would have two answers and
-- every payroll query would need a tie-break nobody wrote down.
CREATE UNIQUE INDEX compensation_agreement_current_key
  ON compensation_agreement (org_id, engagement_id, kind)
  WHERE valid_to IS NULL AND archived_at IS NULL;

COMMENT ON TABLE compensation_agreement IS
  'One person''s pay agreement for one engagement. Mutable ONLY while it has never been contracted: once contract_acceptance names a contract covering this engagement, every figure on it is frozen and a change is a NEW agreement superseding this one, because a pay figure editable after signing is a different dispute.';

-- The freeze. `compensation_is_under_contract` is the query that answers "has anybody
-- signed anything about this engagement", and it is written once because a check that
-- existed in two places would eventually disagree with itself.
CREATE OR REPLACE FUNCTION public.compensation_is_under_contract(p_org_id uuid, p_engagement_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.contract c
      JOIN public.contract_version v
        ON v.org_id = c.org_id AND v.contract_id = c.id
      JOIN public.contract_acceptance a
        ON a.org_id = v.org_id AND a.contract_version_id = v.id
     WHERE c.org_id = p_org_id
       AND c.engagement_id = p_engagement_id
  )
$$;

CREATE OR REPLACE FUNCTION public.guard_compensation_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- DELETE is always refused. This table has no UPDATE path after a contract, but
    -- it has one before, and a rule that only guarded UPDATE would leave the door open
    -- for the whole time the table was still draft.
    RAISE EXCEPTION
      'compensation_agreement is not deletable; supersede it with a new agreement or archive it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Archiving is permitted at any time and is not a change to any figure, so it is
  -- allowed past the freeze. Only a change to the money or the window is not.
  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN

    IF public.compensation_is_under_contract(OLD.org_id, OLD.engagement_id) THEN
      RAISE EXCEPTION
        'compensation_agreement % covers engagement %, which is under an accepted contract; its figures cannot be changed, because the figure that applied when the contract was signed must remain answerable. Record a new agreement instead.',
        OLD.id, OLD.engagement_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_compensation_freeze() IS
  'Refuses DELETE on a compensation agreement, and refuses a change to any figure or effective date once an accepted contract covers the engagement. Archiving stays available: it is not a change to what was agreed.';

REVOKE ALL ON FUNCTION public.guard_compensation_freeze() FROM PUBLIC;

CREATE TRIGGER compensation_agreement_frozen_under_contract
  BEFORE UPDATE OR DELETE ON compensation_agreement
  FOR EACH ROW EXECUTE FUNCTION public.guard_compensation_freeze();

-- -----------------------------------------------------------------------------
-- HR LIFECYCLE — AN EXPLICIT STATE MACHINE WITH A TRANSITION TABLE
--
-- WHERE THE STATE IS STORED, AND WHAT ENFORTS THE TRANSITIONS. Stated here rather
-- than left for a reader to infer, because the honest answer is split:
--
--   * The CURRENT state is stored on `hr_record.state`. Not derived, not computed,
--     not cached — stored, so that "where is this person in their employment" is one
--     indexed read rather than a fold over a history.
--
--   * The ALLOWED TRANSITIONS are stored as DATA in `hr_state_transition`, one row
--     per legal (from_state, to_state) pair, seeded per organisation. This is a table
--     and not a constant in a trigger, so that the legal moves are queryable — a
--     compliance report on "what can happen to a suspended contract" is a SELECT,
--     not a reading of application source.
--
--   * The database DOES enforce them. A BEFORE UPDATE trigger refuses a state change
--     that has no row in the transition table, and refuses one whose declared
--     `requires_reason` is not satisfied by an actual reason. An application that
--     writes an illegal transition gets check_violation from the database, not a
--     silently illegal record.
--
--   * WHAT THE DATABASE DOES NOT ENFORCE, said plainly: it does not enforce WHO may
--     perform a transition. Row-level authorisation is packages/auth's concern, and a
--     migration cannot see which session a write came from. The state machine here is
--     about legality of the move, not authority to make it.
--
-- WHY NO `entered_at` PER STATE AND NO AUTO-ADVANCE
-- A transition trigger that auto-advanced a state on a timer would make the stored
-- state a function of the clock rather than of an event, and an HR record that says
-- someone is ACTIVE because nobody has run a job is a claim, not a fact. Every state
-- change is a write somebody chose to make, with a reason where the transition
-- demands one.
-- -----------------------------------------------------------------------------

CREATE TABLE hr_state_transition (
  -- An `id` like every other table, even though nothing references a transition by
  -- one. Carried for uniformity and for the tenancy rule it makes possible:
  -- UNIQUE (org_id, id) is what a child table needs in order to reference this one
  -- without a cross-tenant edge, and a rule that says "every tenant table has it"
  -- and then has one exception is a rule that will be copied.
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   hr_record_state NOT NULL,
  to_state     hr_record_state NOT NULL,
  -- Whether the move needs a stated reason. Terminations and suspensions do;
  -- ordinary progression does not. A reason required and not given is the failure
  -- this column exists to catch.
  requires_reason boolean NOT NULL DEFAULT false,
  description varchar(300),
  CONSTRAINT hr_state_transition_key UNIQUE (org_id, from_state, to_state),
  CONSTRAINT hr_state_transition_no_self_check CHECK (from_state <> to_state),
  CONSTRAINT hr_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX hr_state_transition_org_idx ON hr_state_transition (org_id);

-- The legal lifecycle. Seeded per organisation rather than held in a global table,
-- because an organisation that runs a bootcamp pipeline legitimately has states a
-- sponsorship org does not — and because a global table would be one more thing an
-- organisation could not be different about.
--
-- States NOT reachable from `draft` are the point of the table: `suspended` is only
-- reachable from `active`, so a record cannot be born suspended, and `terminated` is
-- a dead end except for `offboarded`, so a terminated person cannot silently become
-- active again.
CREATE OR REPLACE FUNCTION public.seed_hr_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.hr_state_transition (org_id, from_state, to_state, requires_reason, description)
  VALUES
    (p_org_id, 'draft',       'offered',     false, 'Offer extended'),
    (p_org_id, 'draft',       'terminated',  true,  'Withdrawn before an offer was made'),
    (p_org_id, 'offered',     'onboarding',  false, 'Offer accepted'),
    (p_org_id, 'offered',     'terminated',  true,  'Offer declined or withdrawn'),
    (p_org_id, 'onboarding',  'active',      false, 'Onboarding complete'),
    (p_org_id, 'onboarding',  'terminated',  true,  'Onboarding abandoned'),
    (p_org_id, 'active',      'leave',       true,  'Extended leave'),
    (p_org_id, 'active',      'suspended',   true,  'Suspension'),
    (p_org_id, 'active',      'notice',      false, 'Notice given'),
    (p_org_id, 'leave',       'active',      false, 'Returned from leave'),
    (p_org_id, 'leave',       'notice',      true,  'Notice given while on leave'),
    (p_org_id, 'leave',       'terminated',  true,  'Terminated while on leave'),
    (p_org_id, 'suspended',   'active',      true,  'Suspension lifted'),
    (p_org_id, 'suspended',   'terminated',  true,  'Terminated while suspended'),
    (p_org_id, 'suspended',   'notice',      true,  'Notice given while suspended'),
    (p_org_id, 'notice',      'terminated',  true,  'Termination effective'),
    (p_org_id, 'notice',      'active',      true,  'Notice withdrawn'),
    (p_org_id, 'terminated',  'offboarded',  false, 'Offboarding complete')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_hr_state_transition(uuid) IS
  'Seeds an organisation''s legal HR transitions. Data rather than code so the lifecycle is queryable, and per-organisation so an org with a different pipeline is not forced into this one.';

REVOKE ALL ON FUNCTION public.seed_hr_state_transition(uuid) FROM PUBLIC;

-- Fired when an organisation is created, so the machine exists before anybody can
-- write a record and there is no window in which a record could be written into an
-- organisation with an empty (and therefore "nothing is legal") transition set.
--
-- Empty-means-nothing-legal is the safe direction: an organisation whose seed failed
-- refuses every state change rather than accepting every one.
CREATE OR REPLACE FUNCTION public.on_organization_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_hr_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created() IS
  'Seeds the HR state machine for a new organisation at creation, so no organisation can exist without one and every record is judged against a populated transition table.';

REVOKE ALL ON FUNCTION public.on_organization_created() FROM PUBLIC;

CREATE TRIGGER organization_seeds_hr_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created();

CREATE TABLE hr_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL,
  state         hr_record_state NOT NULL DEFAULT 'draft',
  -- WHY the record is in this state, and the mandatory reason when the transition
  -- table says the move required one. Stored beside the state rather than on a
  -- separate transition-history table so that "why is this person suspended" is one
  -- indexed read; the reasons accumulate on the record the way a file does.
  state_reason  varchar(400),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  state_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT hr_record_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_record_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX hr_record_org_idx          ON hr_record (org_id);
CREATE INDEX hr_record_org_person_idx   ON hr_record (org_id, person_id);
CREATE INDEX hr_record_org_engagement_idx ON hr_record (org_id, engagement_id);
CREATE INDEX hr_record_org_state_idx    ON hr_record (org_id, state);

-- One CURRENT HR record per engagement. A person may be re-engaged later, and that is
-- a second record with a second window; but an engagement with two live HR records
-- would give "what state is this person in" two answers.
CREATE UNIQUE INDEX hr_record_current_key
  ON hr_record (org_id, engagement_id)
  WHERE archived_at IS NULL;

COMMENT ON TABLE hr_record IS
  'The current HR state of one engagement. The state is STORED here, and the legal transitions are DATA in hr_state_transition, enforced by a trigger — see the header for exactly what that does and does not guarantee.';

CREATE OR REPLACE FUNCTION public.guard_hr_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
  v_known    boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    -- Nothing about the lifecycle changed. An edit to the reason text alone is not a
    -- transition and is not guarded, because refusing it would make the row
    -- uneditable in every other respect too.
    RETURN NEW;
  END IF;

  SELECT t.requires_reason, true
    INTO v_requires, v_known
    FROM public.hr_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'HR record % cannot move from % to %: no such transition is defined for this organisation. hr_state_transition is where the legal moves are recorded, and it is the authority — not application code.',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_requires AND (NEW.state_reason IS NULL OR btrim(NEW.state_reason) = '') THEN
    RAISE EXCEPTION
      'HR record % moving from % to % requires a stated reason',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- The actor is who moved it, not who created it. Without this, "who suspended
  -- this player" has no answer for anybody but the database.
  IF NEW.state_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'HR record % changed state from % to % without naming who made the change',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_hr_transition() IS
  'Refuses an HR state change that hr_state_transition does not declare, a declared-but-reason-requiring change with no reason, and a change with no actor. Does not check WHO may make the transition — authorisation is not a database concern here and is not implied by this trigger.';

REVOKE ALL ON FUNCTION public.guard_hr_transition() FROM PUBLIC;

CREATE TRIGGER hr_record_transition_is_legal
  BEFORE UPDATE OF state ON hr_record
  FOR EACH ROW EXECUTE FUNCTION public.guard_hr_transition();

-- -----------------------------------------------------------------------------
-- DOCUMENTS AND EXPIRY
--
-- `issued_at` and `expires_at` are INSTANTS, not dates, and that is the whole point
-- of this section: a work permit that expires "at 00:00 on the 31st" and one that
-- expires "at 23:59 on the 30th" are different facts, and flattening either to a date
-- invents a day nobody agreed to.
--
-- `date` IS used in exactly one place in this table — `expiry_notice_days`, a notice
-- period — because a notice period is a count of days, not an instant. That column is
-- an integer, so the naming is what carries the unit, the same discipline 0007 applied
-- to `survival_time_seconds`.
--
-- THE BOUNDARY IS INCLUSIVE ON EXPIRY AND THE QUERY SAYS SO EXPLICITLY
-- ------------------------------------------------------------------
-- "What is expired as of date D" is asked of a `timestamptz` boundary constantly, and
-- the two halves of that sentence come apart at the exact instant:
--
--   expires_at <= D  says "already expired at D"
--   expires_at <  D  says "not expired until the moment AFTER D"
--
-- Which one is correct depends entirely on whether `expires_at` is the instant the
-- document STOPS being valid or the instant it CEASES to be valid. A document whose
-- `expires_at` is 00:00:00 on the 31st is valid for every second up to that instant
-- and expired AT it, so `expires_at <= D` is the correct reading and `expires_at < D`
-- would expire the document one instant early — at 23:59:59.999 on the 30th, a day
-- nobody wrote down.
--
-- So `person_document_expiry_status` below uses `<=` and says so in a COMMENT, and
-- the boundary is asserted by a named test at D-1ms, D exactly, and D+1ms. A reader
-- who disagrees with that reading can see exactly one line to change, and the change
-- is visible as a failing boundary test rather than as a silent off-by-one.
--
-- NO QUEUE, NO JOB, NO outbox row here. Reminding anybody about an expiry is
-- DELIVERY, and another package owns delivery; this table's whole job is to make the
-- question ANSWERABLE (`person_document_expiry_status`, plus the plain composite
-- index below for anyone who would rather write the predicate themselves). A
-- `next_reminder_at` column written by this schema would be a claim that a reminder
-- was scheduled, which is exactly the kind of claim ADR-0019 exists to stop storing.
-- -----------------------------------------------------------------------------

CREATE TABLE person_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  kind          person_document_kind NOT NULL,
  title         varchar(200) NOT NULL,
  -- WHERE the document is. The bytes live outside this database; this is the pointer
  -- and the checksum, and `document_hash` is what makes the pointer checkable.
  storage_ref   text NOT NULL,
  document_hash char(64) NOT NULL,
  -- WHEN IT WAS ISSUED and WHEN IT STOPS BEING VALID. Both instants, both NOT NULL
  -- for a document that can expire. An issued_at in the future is not refused — a
  -- signed contract is issued when it is signed, and a scheduled visa may be recorded
  -- before it exists — but the CHECK below refuses an expiry that PRECEDES its issue,
  -- which is not a future document but an arithmetic error.
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz,
  -- Days before expiry at which somebody should be told. An INTEGER because it counts
  -- days; naming it is the discipline, the type is just the consequence.
  expiry_notice_days integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT person_document_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT person_document_hash_shape_check CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT person_document_storage_check CHECK (btrim(storage_ref) <> ''),
  -- An expiry before the issue is not a very short document, it is a mistake, and it
  -- is the kind that makes "is this expired" answerable in a way nobody can defend.
  CONSTRAINT person_document_expiry_after_issue_check
    CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT person_document_notice_days_check
    CHECK (expiry_notice_days IS NULL OR expiry_notice_days BETWEEN 0 AND 365)
);

CREATE INDEX person_document_org_idx      ON person_document (org_id);
CREATE INDEX person_document_org_person_idx ON person_document (org_id, person_id);

-- The expiry query, answered by an index rather than by a table scan. Leading with
-- org_id is the tenancy rule; `expires_at` follows because the only question anyone
-- asks this table in a loop is "what is about to expire".
CREATE INDEX person_document_org_expiry_idx ON person_document (org_id, expires_at);

-- At most one current document per (person, kind). Two current right-to-work checks
-- would leave "does this player have right to work" with two answers, and the second
-- one is presumably a replacement that was never marked as one.
CREATE UNIQUE INDEX person_document_current_key
  ON person_document (org_id, person_id, kind)
  WHERE archived_at IS NULL;

COMMENT ON TABLE person_document IS
  'One document belonging to one person, with the instants it was issued and stops being valid. Reminders are NOT scheduled here: delivery belongs to another package, and this table''s job is to make the question answerable.';

CREATE OR REPLACE FUNCTION public.person_document_expiry_status(p_as_of timestamptz)
RETURNS TABLE (
  document_id      uuid,
  person_id        uuid,
  kind             person_document_kind,
  title            varchar(200),
  issued_at        timestamptz,
  expires_at       timestamptz,
  expiry_notice_days integer,
  is_expired       boolean,
  seconds_to_expiry numeric
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id,
         d.person_id,
         d.kind,
         d.title,
         d.issued_at,
         d.expires_at,
         d.expiry_notice_days,
         -- `<=` NOT `<`. `expires_at` is the instant validity ENDS, so a document is
         -- expired AT that instant and not one microsecond before it. Using `<` here
         -- would expire every document an instant early — at 23:59:59.999999 on the
         -- previous day — which is a day nobody agreed to. The boundary is asserted by
         -- a named test so that changing this line changes a failing test rather than
         -- silently shifting every expiry by a day.
         (d.expires_at <= p_as_of) AS is_expired,
         -- Numeric, not an interval: the caller wants a sortable number for "soonest
         -- first", and an interval does not order across a timestamptz gap without a
         -- cast that each caller would then have to remember.
         round(extract(epoch FROM (d.expires_at - p_as_of))::numeric, 0) AS seconds_to_expiry
    FROM public.person_document d
   WHERE d.org_id = public.current_org_id()
     AND d.archived_at IS NULL
     AND d.expires_at IS NOT NULL
     -- The same `<=` boundary as is_expired, so the two can never disagree: a
     -- document reported as expired by this filter is expired by the expression
     -- beside it. A query whose two halves could disagree is a query nobody trusts.
     AND d.expires_at <= p_as_of
   ORDER BY d.expires_at ASC, d.id ASC
$$;

COMMENT ON FUNCTION public.person_document_expiry_status(timestamptz) IS
  'Documents expired as of an instant, tenant-scoped from the session with no tenant parameter (ADR-0011 rule 3). The boundary is expires_at <= p_as_of: expiry is the instant validity ends, so a document is expired AT that instant, not one microsecond before. Returns every expired document with no cap and no silent truncation; the caller filters by severity.';

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced on every table this file creates, with the tenant predicate as
-- the whole policy and no IS NULL escape, so an unset tenant context hides every row
-- rather than exposing them (ADR-0015). `guardian_consent` was enabled but had NO
-- policy and NO org_id in 0001; both are corrected above, and the policy added here
-- is the first one it has ever had.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'contract','contract_version','contract_acceptance','acceptance_withdrawal',
    'compensation_agreement','hr_record','hr_state_transition','person_document',
    'guardian_consent','guardian_consent_withdrawal'
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
--
-- The GRANT is the second of the two independent append-only mechanisms. The trigger
-- above denies UPDATE and DELETE to everybody; the GRANT removes the application
-- role's permission before it can be attempted, so the refusal a caller sees is a
-- privilege error rather than a surprising one.
--
-- `hr_state_transition` gets NO INSERT for the application: it is seeded when the
-- organisation is created, and an organisation editing its own legal transitions is a
-- governance act belonging to a migration or an operator, not to the request path.
-- The same argument as 0004's `expense`: "exactly one component can create this row"
-- is a property of the GRANT rather than a convention two components agreed between
-- themselves.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables get INSERT and UPDATE. UPDATE is what makes a draft editable, a
-- compensation figure amendable BEFORE it is contracted, and an HR state machine
-- walkable — three different things that all need it, and the guards above are what
-- stop it being used for anything else.
GRANT SELECT, INSERT, UPDATE ON
  contract, compensation_agreement, hr_record, person_document
TO raptor_app;

-- Append-only tables: INSERT only. See the note below on why this is also a REVOKE.
GRANT SELECT, INSERT ON
  contract_version, contract_acceptance, acceptance_withdrawal,
  guardian_consent, guardian_consent_withdrawal
TO raptor_app;

GRANT SELECT ON hr_state_transition TO raptor_app;
REVOKE INSERT, UPDATE, DELETE ON hr_state_transition FROM raptor_app;

-- Append-only tables: SELECT and INSERT, and nothing else. Stated as an explicit
-- REVOKE as well as an absent GRANT, because 0001 granted ALL on `guardian_consent`
-- and this is where that grant is taken back.
REVOKE UPDATE, DELETE ON
  contract_version, contract_acceptance, acceptance_withdrawal,
  guardian_consent, guardian_consent_withdrawal
FROM raptor_app;

REVOKE DELETE ON contract, compensation_agreement, hr_record, person_document FROM raptor_app;

-- The reporting functions are SECURITY DEFINER for the ones that must read past a
-- policy (guardian_consent_covers, compensation_is_under_contract, guard_*), and
-- SECURITY INVOKER for the ones that only report. Both are revoked from PUBLIC and
-- granted explicitly, so a role in the database with no grants on these tables cannot
-- call them.
REVOKE ALL ON FUNCTION public.majority_status(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.contract_content_hash(uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_consent_covers_in_org(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_consent_covers(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compensation_is_under_contract(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_hr_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_version_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_version_sealing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_acceptance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_minor_engagement() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_compensation_freeze() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_hr_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_people_append_only_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.person_document_expiry_status(timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.majority_status(date, date),
  public.contract_content_hash(uuid, integer, text, text),
  public.guardian_consent_covers(uuid, uuid, timestamptz),
  public.person_document_expiry_status(timestamptz)
TO raptor_app;

-- RLS is worthless to a role that can switch it off. Restated at the end of the file,
-- as 0001, 0002, 0004, 0005, 0006 and 0007 each do.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;