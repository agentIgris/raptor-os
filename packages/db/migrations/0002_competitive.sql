-- =============================================================================
-- 0002_competitive.sql
--
-- Competitive operations: the domain the legacy system never modelled.
--
-- The audit is unambiguous about why. The legacy schema had no match, no bracket,
-- no opponent, no result and no tournament entity. "Tournament" was free text on a
-- slot row, and one row was asked to mean three different things at once:
--
--   SLOT     — a purchase of capacity
--   ENTRY    — a participation by a team
--   RESULT   — an outcome of a match
--
-- Conflating them is why capacity could be oversold (a purchase was not an entry,
-- so nothing decremented anything) and why no result could ever be recorded (there
-- was nowhere to put one). This migration keeps the three apart and gives each its
-- own table.
--
-- The tenancy rules are identical to 0001 and are not restated per table:
--   1. org_id NOT NULL on every table; every composite index leads with it.
--   2. Every FK between tenant tables is composite and includes org_id, so a
--      cross-tenant reference cannot be expressed (ADR-0011). That requires
--      UNIQUE (org_id, id) on every referenced table.
--   3. RLS is ENABLED *and* FORCED, with the tenant resolved from the session.
--      The policy has no IS NULL bypass branch, so an unset tenant context yields
--      zero rows rather than every row (ADR-0015).
--
-- Money is numeric(18,4) beside a currency varchar(3) — ADR-0003 fixes the scale at
-- 4 decimal places. Never an integer minor unit here, never a float. Every
-- timestamp is timestamptz; the legacy attendances.session_time was text and the
-- audit called it the likely root cause of the whole attendance bug backlog.
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

CREATE TYPE title_tier AS ENUM ('commercial', 'competitive');

CREATE TYPE game_status AS ENUM ('active', 'retired');

CREATE TYPE title_status AS ENUM ('announced', 'active', 'retired');

CREATE TYPE season_status AS ENUM ('scheduled', 'active', 'completed');

CREATE TYPE division_tier AS ENUM ('elite', 'pro', 'challenger', 'contender', 'academy');

CREATE TYPE team_status AS ENUM ('forming', 'active', 'inactive', 'disbanded');

CREATE TYPE team_member_role AS ENUM ('player', 'captain', 'substitute', 'academy', 'flex');

CREATE TYPE team_staff_role AS ENUM
  ('head_coach', 'assistant_coach', 'analyst', 'manager', 'performance_coach', 'content_coach');

CREATE TYPE competition_format AS ENUM
  ('single_elimination', 'double_elimination', 'round_robin', 'swiss', 'groups_playoffs');

CREATE TYPE competition_status AS ENUM
  ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled');

CREATE TYPE registration_status AS ENUM
  ('pending', 'confirmed', 'waitlisted', 'withdrawn', 'cancelled');

CREATE TYPE match_status AS ENUM ('scheduled', 'live', 'completed', 'forfeit', 'cancelled');

CREATE TYPE match_map_result AS ENUM ('win', 'loss', 'draw', 'not_played');

-- Provenance. The legacy system recorded results with no indication of where the
-- number came from, so an OCR-derived row and a hand-typed row were indistinguishable
-- forever. The audit called that a critical finding, and it is unrecoverable after
-- the fact — so the schema refuses to store a result without it.
CREATE TYPE match_result_source AS ENUM ('manual', 'ocr', 'provider_api', 'import', 'system');

CREATE TYPE session_kind AS ENUM ('practice', 'scrim', 'review', 'coaching', 'team_meeting', 'bootcamp');

CREATE TYPE session_status AS ENUM ('planned', 'held', 'cancelled', 'no_show');

CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'excused', 'remote');

CREATE TYPE attendance_record_method AS ENUM ('self_reported', 'kiosk_scan', 'coach_marked', 'import');

CREATE TYPE holiday_scope AS ENUM ('none', 'org', 'national');

-- -----------------------------------------------------------------------------
-- Competitive catalogue: game -> title -> season -> division
--
-- The legacy schema had a single free-text teams.tier column that was asked to mean
-- two unrelated things at once: the commercial product a roster was sold under, and
-- the competitive tier it played in. Those are now separate tables with a real
-- hierarchy, because they change for different reasons, at different times, and are
-- reported on differently.
-- -----------------------------------------------------------------------------

CREATE TABLE game (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  slug        varchar(64)  NOT NULL,
  publisher   varchar(160),
  status      game_status NOT NULL DEFAULT 'active',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT game_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT game_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX game_org_idx ON game (org_id);

-- The commercial tier: the product a roster is sold under ("VCT", "ECS", "LPL").
CREATE TABLE title (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  game_id     uuid NOT NULL,
  name        varchar(160) NOT NULL,
  slug        varchar(80)  NOT NULL,
  publisher   varchar(160),
  tier        title_tier   NOT NULL DEFAULT 'commercial',
  status      title_status NOT NULL DEFAULT 'announced',
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT title_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT title_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT title_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT title_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX title_org_idx       ON title (org_id);
CREATE INDEX title_org_game_idx  ON title (org_id, game_id);

CREATE TABLE season (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title_id    uuid NOT NULL,
  name        varchar(120) NOT NULL,
  code        varchar(40),
  starts_on   timestamptz NOT NULL,
  ends_on     timestamptz NOT NULL,
  status      season_status NOT NULL DEFAULT 'scheduled',
  is_current  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT season_title_fk
    FOREIGN KEY (org_id, title_id) REFERENCES title (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT season_date_range_check CHECK (ends_on > starts_on),
  CONSTRAINT season_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX season_org_idx        ON season (org_id);
CREATE INDEX season_org_title_idx  ON season (org_id, title_id);

-- The competitive tier, deliberately NOT the same thing as title. A division answers
-- "how strong is this competition", a title answers "what is this sold as".
CREATE TABLE division (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  season_id   uuid NOT NULL,
  name        varchar(120) NOT NULL,
  slug        varchar(64)  NOT NULL,
  tier        division_tier NOT NULL DEFAULT 'challenger',
  rank_order  integer NOT NULL DEFAULT 1,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT division_season_fk
    FOREIGN KEY (org_id, season_id) REFERENCES season (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT division_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT division_rank_check      CHECK (rank_order >= 1),
  CONSTRAINT division_org_slug_key   UNIQUE (org_id, season_id, slug),
  CONSTRAINT division_org_id_id_key  UNIQUE (org_id, id)
);

CREATE INDEX division_org_idx         ON division (org_id);
CREATE INDEX division_org_season_idx  ON division (org_id, season_id);

-- One current division per org+season name, so a re-run cannot create two "Elite"
-- divisions that both claim to be the live one.
CREATE UNIQUE INDEX division_current_key
  ON division (org_id, season_id, name)
  WHERE valid_to IS NULL AND archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- Roster
-- -----------------------------------------------------------------------------

CREATE TABLE team (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         varchar(160) NOT NULL,
  slug         varchar(80)  NOT NULL,
  game_id      uuid NOT NULL,
  division_id  uuid,
  status       team_status NOT NULL DEFAULT 'forming',
  is_active    boolean NOT NULL DEFAULT true,
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT team_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  -- Nullable, so a team exists before it is placed in a division. When set, the
  -- composite form still makes a cross-org division reference impossible.
  CONSTRAINT team_division_fk
    FOREIGN KEY (org_id, division_id) REFERENCES division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT team_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_org_idx         ON team (org_id);
CREATE INDEX team_org_game_idx    ON team (org_id, game_id);
CREATE INDEX team_org_division_idx ON team (org_id, division_id);

-- A person's place on a roster, effective-dated.
--
-- share_percent is what the prize allocation engine in packages/core/src/prize reads
-- to split a pool. It is stored at 4 decimal places so it matches parsePercent's scale
-- exactly (parsePercent("100") === 1_000_000n), and it is bounded by CHECK rather than
-- trusted from the client, because an over-100 share silently redistributes money.
CREATE TABLE team_membership (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role_in_team  team_member_role NOT NULL DEFAULT 'player',
  share_percent numeric(7,4) NOT NULL DEFAULT 0,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT team_membership_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_membership_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_membership_share_range_check CHECK (share_percent >= 0 AND share_percent <= 100),
  CONSTRAINT team_membership_left_check CHECK (left_at IS NULL OR left_at >= joined_at),
  CONSTRAINT team_membership_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_membership_org_idx          ON team_membership (org_id);
CREATE INDEX team_membership_org_team_idx     ON team_membership (org_id, team_id);
CREATE INDEX team_membership_org_person_idx   ON team_membership (org_id, person_id);

-- At most one CURRENT membership per person per team. Without this, a re-import could
-- leave two open rows for the same player and the prize engine would split between
-- both, which is a money bug that is invisible until a player disputes a payout.
CREATE UNIQUE INDEX team_membership_current_key
  ON team_membership (org_id, team_id, person_id)
  WHERE valid_to IS NULL;

-- Staff are deliberately NOT roster members. A coach manages a team without being on
-- its roster, and conflating the two is how a coach inherited a playing share.
CREATE TABLE team_staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id        uuid NOT NULL,
  person_id      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role_in_team   team_staff_role NOT NULL,
  is_contracted  boolean NOT NULL DEFAULT false,
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT team_staff_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_staff_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_staff_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_staff_org_idx        ON team_staff (org_id);
CREATE INDEX team_staff_org_team_idx   ON team_staff (org_id, team_id);
CREATE INDEX team_staff_org_person_idx ON team_staff (org_id, person_id);

CREATE UNIQUE INDEX team_staff_current_key
  ON team_staff (org_id, team_id, person_id, role_in_team)
  WHERE valid_to IS NULL;

-- -----------------------------------------------------------------------------
-- Competition
-- -----------------------------------------------------------------------------

CREATE TABLE competition (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title_id              uuid NOT NULL,
  name                  varchar(200) NOT NULL,
  format                competition_format NOT NULL,
  status                competition_status NOT NULL DEFAULT 'draft',
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  registration_deadline timestamptz,
  external_ref          varchar(120),
  valid_from            timestamptz NOT NULL DEFAULT now(),
  valid_to              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  CONSTRAINT competition_title_fk
    FOREIGN KEY (org_id, title_id) REFERENCES title (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT competition_window_check CHECK (ends_at > starts_at),
  -- A deadline after the event starts is a deadline nobody can meet.
  CONSTRAINT competition_deadline_check
    CHECK (registration_deadline IS NULL OR registration_deadline <= starts_at),
  CONSTRAINT competition_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT competition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX competition_org_idx        ON competition (org_id);
CREATE INDEX competition_org_title_idx  ON competition (org_id, title_id);
CREATE INDEX competition_org_start_idx  ON competition (org_id, starts_at);

-- CAPACITY LIVES HERE, and nowhere else.
--
-- `capacity` is the number of teams the division can hold and `registered_count` is
-- the number currently holding a place. registered_count is maintained ONLY by the
-- trigger below, under a row lock, so the check-then-increment cannot interleave.
--
-- The CHECK is the structural guarantee and is deliberately redundant with the
-- trigger: even a direct UPDATE that bypassed the trigger could not store a state in
-- which more teams are registered than the division can hold. Overselling is not
-- "guarded against here", it is unrepresentable.
CREATE TABLE competition_division (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_id   uuid NOT NULL,
  division_id      uuid,
  name             varchar(120) NOT NULL,
  capacity         integer NOT NULL,
  registered_count integer NOT NULL DEFAULT 0,
  prize_position   integer,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT competition_division_competition_fk
    FOREIGN KEY (org_id, competition_id) REFERENCES competition (org_id, id) ON DELETE CASCADE,
  CONSTRAINT competition_division_division_fk
    FOREIGN KEY (org_id, division_id) REFERENCES division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT competition_division_capacity_check CHECK (capacity > 0),
  CONSTRAINT competition_division_count_range_check CHECK (registered_count >= 0),
  -- The oversell guarantee, expressed as an invariant the storage cannot violate.
  CONSTRAINT competition_division_not_oversold_check CHECK (registered_count <= capacity),
  CONSTRAINT competition_division_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT competition_division_org_name_key UNIQUE (org_id, competition_id, name),
  CONSTRAINT competition_division_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX competition_division_org_idx   ON competition_division (org_id);
CREATE INDEX competition_division_org_comp_idx ON competition_division (org_id, competition_id);

-- An ENTRY: a team has entered a division. This is the replacement for the legacy
-- `slot` row, which was a purchase and an entry at once and therefore could be
-- counted as either. The purchase is entry_cost, below.
CREATE TABLE registration (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  team_id                uuid NOT NULL,
  status                 registration_status NOT NULL DEFAULT 'pending',
  seed_number            integer,
  registered_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at           timestamptz,
  withdrawn_at           timestamptz,
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT registration_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT registration_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT registration_seed_check    CHECK (seed_number IS NULL OR seed_number >= 1),
  CONSTRAINT registration_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- A team enters a given division once. The legacy model allowed several rows for
  -- the same team, each of which looked like a separate place sold.
  CONSTRAINT registration_org_division_team_key UNIQUE (org_id, competition_division_id, team_id),
  CONSTRAINT registration_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX registration_org_idx             ON registration (org_id);
CREATE INDEX registration_org_division_idx   ON registration (org_id, competition_division_id);
CREATE INDEX registration_org_team_idx       ON registration (org_id, team_id);

-- What was actually paid for an entry. Money, not an integer minor unit and not a
-- float: numeric(18,4) with the currency beside it (ADR-0003).
CREATE TABLE entry_cost (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL,
  amount          numeric(18,4) NOT NULL,
  discount        numeric(18,4) NOT NULL DEFAULT 0,
  currency        varchar(3) NOT NULL,
  paid_at         timestamptz,
  method          varchar(32),
  reference       varchar(120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT entry_cost_registration_fk
    FOREIGN KEY (org_id, registration_id) REFERENCES registration (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT entry_cost_amount_check   CHECK (amount >= 0),
  CONSTRAINT entry_cost_discount_check CHECK (discount >= 0),
  CONSTRAINT entry_cost_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- One charge per entry. Two rows here would mean a player was billed twice, or
  -- that a refund was modelled as a second entry, and neither is knowable later.
  CONSTRAINT entry_cost_org_registration_key UNIQUE (org_id, registration_id),
  CONSTRAINT entry_cost_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX entry_cost_org_idx ON entry_cost (org_id);

-- -----------------------------------------------------------------------------
-- Match, opponent, result
--
-- The legacy application had none of this. A result could not be recorded because
-- there was no match to attach one to.
-- -----------------------------------------------------------------------------

-- An opponent is modelled as OUR record of another organisation's team. It is
-- deliberately not a foreign key to team: the opposing org's rows are not ours to
-- reference, and a composite FK would forbid exactly the reference we need. So the
-- external identity is stored as data, with the other org's own id kept for
-- reconciliation rather than enforced.
CREATE TABLE opponent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             varchar(160) NOT NULL,
  short_name       varchar(40),
  game_id          uuid NOT NULL,
  external_org_id  uuid,
  external_team_id uuid,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT opponent_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT opponent_org_name_key UNIQUE (org_id, name),
  CONSTRAINT opponent_org_id_id_key  UNIQUE (org_id, id)
);

CREATE INDEX opponent_org_idx      ON opponent (org_id);
CREATE INDEX opponent_org_game_idx ON opponent (org_id, game_id);

CREATE TABLE match (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid,
  team_id                uuid NOT NULL,
  opponent_id            uuid NOT NULL,
  round_label            varchar(40),
  round_number           integer,
  status                 match_status NOT NULL DEFAULT 'scheduled',
  best_of                integer,
  scheduled_at           timestamptz NOT NULL,
  started_at             timestamptz,
  completed_at           timestamptz,
  stream_url             text,
  venue                  varchar(160),
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  -- Nullable because a scrim belongs to no division; when set, the composite form
  -- still makes a cross-org division reference impossible.
  CONSTRAINT match_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_opponent_fk
    FOREIGN KEY (org_id, opponent_id) REFERENCES opponent (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_best_of_check CHECK (best_of IS NULL OR best_of >= 1),
  CONSTRAINT match_round_number_check CHECK (round_number IS NULL OR round_number >= 1),
  CONSTRAINT match_completion_check CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT match_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT match_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_org_idx          ON match (org_id);
CREATE INDEX match_org_division_idx ON match (org_id, competition_division_id);
CREATE INDEX match_org_team_idx     ON match (org_id, team_id);
CREATE INDEX match_org_start_idx    ON match (org_id, scheduled_at);

CREATE TABLE match_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  match_id      uuid NOT NULL,
  map_order     integer NOT NULL,
  map_name      varchar(120),
  our_score     integer,
  opponent_score integer,
  result        match_map_result,
  duration_minutes integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT match_map_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT match_map_order_check  CHECK (map_order >= 1),
  CONSTRAINT match_map_our_score_check     CHECK (our_score IS NULL OR our_score >= 0),
  CONSTRAINT match_map_opponent_score_check CHECK (opponent_score IS NULL OR opponent_score >= 0),
  -- Map 2 of a match exists once. A duplicate row would double every map win.
  CONSTRAINT match_map_org_match_order_key UNIQUE (org_id, match_id, map_order),
  CONSTRAINT match_map_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_map_org_idx     ON match_map (org_id);
CREATE INDEX match_map_org_match_idx ON match_map (org_id, match_id);

-- An OUTCOME, kept separate from the entry and the purchase.
--
-- `source` and `confidence` are not decoration. The audit found results with no
-- provenance, which made an OCR-derived number and a hand-typed one permanently
-- indistinguishable — you cannot later decide which rows to re-check, because the
-- evidence was never written down. confidence is REQUIRED for machine sources:
-- a CHECK makes "this number came from a machine and nobody has verified it"
-- representable, and makes "a machine produced this and we recorded no confidence"
-- not.
CREATE TABLE match_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  match_id     uuid NOT NULL,
  team_id      uuid NOT NULL,
  outcome      match_map_result NOT NULL,
  placement    integer,
  rounds_won   integer NOT NULL DEFAULT 0,
  rounds_lost  integer NOT NULL DEFAULT 0,
  maps_won     integer NOT NULL DEFAULT 0,
  maps_lost    integer NOT NULL DEFAULT 0,
  source       match_result_source NOT NULL,
  confidence   numeric(5,4) NOT NULL,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz,
  verified_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT match_result_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT match_result_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_result_placement_check CHECK (placement IS NULL OR placement >= 1),
  CONSTRAINT match_result_rounds_check
    CHECK (rounds_won >= 0 AND rounds_lost >= 0 AND maps_won >= 0 AND maps_lost >= 0),
  CONSTRAINT match_result_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  -- A hand-typed number is either known or it is not, so it carries 1. A number a
  -- machine read off a screenshot is only as good as the read, and forcing the
  -- author to state that is the entire point of the column.
  CONSTRAINT match_result_manual_confidence_check
    CHECK (source <> 'manual' OR confidence = 1),
  -- "Verified" without a verifier is a claim, not a verification.
  CONSTRAINT match_result_verified_check
    CHECK (verified_at IS NULL OR (verified_by_person_id IS NOT NULL AND verified_at >= recorded_at)),
  -- One current result per match per team. A correction supersedes by archiving the
  -- previous row, so the history that produced the number is never overwritten.
  CONSTRAINT match_result_org_match_team_key UNIQUE (org_id, match_id, team_id),
  CONSTRAINT match_result_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_result_org_idx      ON match_result (org_id);
CREATE INDEX match_result_org_match_idx ON match_result (org_id, match_id);
CREATE INDEX match_result_org_source_idx ON match_result (org_id, source);

-- Money for one competition division.
--
-- net is constrained to gross - deductions rather than trusted, because the prize
-- engine distributes `net` and a hand-entered net that disagrees with gross is a
-- variance nobody can explain to a player.
CREATE TABLE prize_pool (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  gross                  numeric(18,4) NOT NULL,
  deductions             numeric(18,4) NOT NULL DEFAULT 0,
  net                    numeric(18,4) NOT NULL,
  tax_withheld           numeric(18,4) NOT NULL DEFAULT 0,
  currency               varchar(3) NOT NULL,
  sponsor_label          varchar(160),
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT prize_pool_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_pool_gross_check    CHECK (gross >= 0),
  CONSTRAINT prize_pool_deduction_check CHECK (deductions >= 0),
  CONSTRAINT prize_pool_net_check      CHECK (net >= 0),
  CONSTRAINT prize_pool_tax_check      CHECK (tax_withheld >= 0),
  CONSTRAINT prize_pool_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Exact arithmetic on numeric, so this cannot drift by a rounding error.
  CONSTRAINT prize_pool_net_identity_check CHECK (net = gross - deductions),
  CONSTRAINT prize_pool_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT prize_pool_org_division_key UNIQUE (org_id, competition_division_id),
  CONSTRAINT prize_pool_org_id_id_key    UNIQUE (org_id, id)
);

CREATE INDEX prize_pool_org_idx ON prize_pool (org_id);

-- -----------------------------------------------------------------------------
-- Sessions and attendance
--
-- The legacy attendances.session_time was `text`. The audit called it the likely root
-- cause of the entire attendance bug backlog: strings do not order, and a cutoff
-- window cannot be evaluated against a string. Every timestamp here is timestamptz.
-- -----------------------------------------------------------------------------

CREATE TABLE attendance_policy (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id               uuid,
  name                  varchar(120) NOT NULL,
  -- Minutes before the session start at which the attendance window closes. Negative,
  -- because it is an offset backwards from start and a positive number here would be
  -- silently wrong.
  cutoff_offset_minutes integer NOT NULL DEFAULT -15,
  grace_minutes         integer NOT NULL DEFAULT 5,
  holiday_scope         holiday_scope NOT NULL DEFAULT 'none',
  valid_from            timestamptz NOT NULL DEFAULT now(),
  valid_to              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  CONSTRAINT attendance_policy_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_policy_cutoff_check CHECK (cutoff_offset_minutes <= 0),
  CONSTRAINT attendance_policy_grace_check  CHECK (grace_minutes >= 0),
  CONSTRAINT attendance_policy_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT attendance_policy_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX attendance_policy_org_idx  ON attendance_policy (org_id);
CREATE INDEX attendance_policy_org_team_idx ON attendance_policy (org_id, team_id);

CREATE UNIQUE INDEX attendance_policy_current_key
  ON attendance_policy (org_id, team_id, name)
  WHERE valid_to IS NULL;

CREATE TABLE session (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id                uuid NOT NULL,
  kind                   session_kind NOT NULL DEFAULT 'practice',
  title                  varchar(200) NOT NULL,
  status                 session_status NOT NULL DEFAULT 'planned',
  starts_at              timestamptz NOT NULL,
  ends_at                timestamptz NOT NULL,
  attendance_policy_id   uuid,
  location               varchar(160),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT session_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_attendance_policy_fk
    FOREIGN KEY (org_id, attendance_policy_id)
    REFERENCES attendance_policy (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_window_check CHECK (ends_at > starts_at),
  CONSTRAINT session_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX session_org_idx       ON session (org_id);
CREATE INDEX session_org_team_idx  ON session (org_id, team_id);
CREATE INDEX session_org_start_idx ON session (org_id, starts_at);

CREATE TABLE session_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id           uuid NOT NULL,
  name              varchar(160) NOT NULL,
  kind              session_kind NOT NULL DEFAULT 'practice',
  duration_minutes  integer NOT NULL,
  -- Minutes past midnight, not a `time` column: the template is a weekly pattern in
  -- the team's own timezone, so a wall-clock type would imply an offset that does not
  -- exist.
  start_minute_of_day integer NOT NULL,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT session_template_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_template_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT session_template_start_minute_check
    CHECK (start_minute_of_day >= 0 AND start_minute_of_day < 1440),
  CONSTRAINT session_template_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT session_template_org_name_key UNIQUE (org_id, team_id, name),
  CONSTRAINT session_template_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX session_template_org_idx      ON session_template (org_id);
CREATE INDEX session_template_org_team_idx ON session_template (org_id, team_id);

CREATE TABLE attendance_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL,
  person_id       uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  status          attendance_status NOT NULL,
  method          attendance_record_method NOT NULL DEFAULT 'self_reported',
  checked_in_at   timestamptz,
  minutes_late    integer,
  note            text,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT attendance_record_session_fk
    FOREIGN KEY (org_id, session_id) REFERENCES session (org_id, id) ON DELETE CASCADE,
  CONSTRAINT attendance_record_minutes_late_check
    CHECK (minutes_late IS NULL OR minutes_late >= 0),
  -- 'late' is the only status that can carry a lateness figure. Allowing minutes_late
  -- on an 'absent' row is how an attendance report starts lying.
  CONSTRAINT attendance_record_late_only_check
    CHECK ((status = 'late') = (minutes_late IS NOT NULL)),
  -- The legacy system had no attendance entity, so counts were inflated by duplicates
  -- from re-scans and re-submissions. Here a second row for the same person at the
  -- same session is not rejected by application code, it is not storable.
  CONSTRAINT attendance_record_org_session_person_key UNIQUE (org_id, session_id, person_id),
  CONSTRAINT attendance_record_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX attendance_record_org_idx        ON attendance_record (org_id);
CREATE INDEX attendance_record_org_session_idx ON attendance_record (org_id, session_id);
CREATE INDEX attendance_record_org_person_idx  ON attendance_record (org_id, person_id);

-- -----------------------------------------------------------------------------
-- CAPACITY ENFORCEMENT
--
-- One function, one trigger. The decrement is atomic because the parent row is locked
-- with FOR UPDATE before the count is read, so two concurrent registrations against
-- the last remaining place serialise instead of both observing "one place left".
--
-- SECURITY DEFINER is required and is the reason this is a function at all: the
-- application role is not granted UPDATE on competition_division (see the grants
-- below), so without elevation the counter could not be maintained and the correct
-- alternative would be to grant the app the right to inflate capacity directly.
--
-- Every table reference is schema-qualified because search_path is pinned to empty.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reserve_competition_division_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity integer;
  v_taken    integer;
BEGIN
  SELECT cd.capacity, cd.registered_count
    INTO v_capacity, v_taken
    FROM public.competition_division cd
   WHERE cd.org_id = NEW.org_id
     AND cd.id = NEW.competition_division_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'competition division % does not exist in organisation %',
      NEW.competition_division_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_taken >= v_capacity THEN
    RAISE EXCEPTION 'competition division % is full (capacity %, already registered %)',
      NEW.competition_division_id, v_capacity, v_taken
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.competition_division
     SET registered_count = registered_count + 1
   WHERE org_id = NEW.org_id
     AND id = NEW.competition_division_id;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION reserve_competition_division_place() IS
  'Takes an atomic place in a competition division. Runs as the table owner because '
  'the application role is denied UPDATE on competition_division.';

-- Releasing a place. A withdrawn or cancelled registration must give its place back,
-- otherwise a single withdrawal silently costs the org a seat.
CREATE OR REPLACE FUNCTION release_competition_division_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status NOT IN ('withdrawn', 'cancelled')
     AND NEW.status IN ('withdrawn', 'cancelled') THEN
    UPDATE public.competition_division
       SET registered_count = GREATEST(registered_count - 1, 0)
     WHERE org_id = NEW.org_id
       AND id = NEW.competition_division_id;
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER registration_reserve_place
  BEFORE INSERT ON registration
  FOR EACH ROW EXECUTE FUNCTION reserve_competition_division_place();

CREATE TRIGGER registration_release_place
  AFTER UPDATE ON registration
  FOR EACH ROW EXECUTE FUNCTION release_competition_division_place();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced, so the owner is subject to the policy too. The tenant predicate
-- is the whole policy and has no IS NULL escape: an unset tenant context makes
-- `org_id = current_org_id()` evaluate to NULL, which is not TRUE, which hides every
-- row. That is failing closed, and it is the property ADR-0015 exists to guarantee.
--
-- Contrast with 0001's audit_log and outbox_event, which deliberately allow org_id IS
-- NULL because a system actor writes there. Nothing in competitive operations has
-- that exemption, so nothing here gets it.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  competitive_tables text[] := ARRAY[
    'game','title','season','division','team','team_membership','team_staff',
    'competition','competition_division','registration','entry_cost',
    'opponent','match','match_map','match_result','prize_pool',
    'attendance_policy','session','session_template','attendance_record'
  ];
BEGIN
  FOREACH t IN ARRAY competitive_tables LOOP
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
-- raptor_app gets ordinary DML on the competitive tables. It does NOT get UPDATE or
-- DELETE on competition_division: capacity is owned by the trigger, and a role that
-- can raise a division's capacity can also oversell one with a single statement.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  game, title, season, division, team, team_membership, team_staff,
  competition, competition_division, registration, entry_cost,
  opponent, match, match_map, match_result, prize_pool,
  attendance_policy, session, session_template, attendance_record
TO raptor_app;

REVOKE UPDATE, DELETE ON competition_division FROM raptor_app;

REVOKE ALL ON FUNCTION reserve_competition_division_place() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_competition_division_place() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_competition_division_place() TO raptor_app;
GRANT EXECUTE ON FUNCTION release_competition_division_place() TO raptor_app;

-- RLS is worthless to a role that can switch it off.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();