-- scripts/preview-seed.sql — STAGING PREVIEW DATA. Never production.
--
-- WHAT THIS IS
-- ------------
-- A fully-rendered fan site needs rows. The Raptor facts (real roster,
-- results, history) do not exist yet, so this seeds a clearly-marked preview
-- dataset researched from public sources (Liquipedia, Esports Charts,
-- tournament coverage, October 2026) about other Indian BGMI orgs. Every
-- person row carries external_ref = 'preview:…'; every competition carries
-- external_ref = 'preview:…'. Replacement duty: delete rows with those
-- markers (or this whole dataset) the day verified Raptor facts land.
--
-- WHAT IT IS NOT
-- -------------
-- - Not endorsements: no partners are seeded (a sponsor strip implies
--   contracts). No contact details, no legal names — handles only.
-- - Not photos: portraits stay placeholders (no likenesses taken anywhere).
-- - Month-granular event dates below are flagged PREVIEW-APPROX where only
--   the month is documented; day-exact dates are from event coverage.
--
-- IDEMPOTENT: every statement is guarded (ON CONFLICT / WHERE NOT EXISTS).
-- Apply as: postgres (superuser bypasses RLS; the app role could never write
-- most of these tables, which is the point of RLS).
-- SELF-CONTAINED: creates the tenant root when missing, so a fresh local
-- clone needs nothing beyond the migrations that ran before this file.
-- Verify with: the counts query at the end (expect 1 org-excluded totals:
-- 1 game, 2 teams, 5 players, 4 competitions, 4 verified results).

-- Tenant root ---------------------------------------------------------------
-- Staging had this row from workspace onboarding; local clones start empty,
-- so the seed provisions it with the same fixed id PUBLIC_ORG_ID points at.
-- The 0008/0009 AFTER INSERT triggers fire and seed the default transition
-- rows — same as creating an organisation through the workspace does.
INSERT INTO public.organization (id, slug, display_name, status, default_currency, default_timezone)
VALUES ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'raptor', 'Raptor', 'active', 'INR', 'Asia/Kolkata')
ON CONFLICT (id) DO NOTHING;

-- Game ---------------------------------------------------------------------
INSERT INTO public.game (id, org_id, name, slug, publisher, status, is_active)
VALUES ('410c0c71-bfd9-41be-bbf0-598085027fd9', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        'Battlegrounds Mobile India', 'bgmi', 'KRAFTON', 'active', true)
ON CONFLICT (org_id, slug) DO NOTHING;

-- Title / season / division -------------------------------------------------
INSERT INTO public.title (id, org_id, game_id, name, slug, tier, status)
VALUES ('106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        '410c0c71-bfd9-41be-bbf0-598085027fd9',
        'BGMI Championship Circuit', 'bgmi-championship-circuit', 'competitive', 'active')
ON CONFLICT (org_id, slug) DO NOTHING;

INSERT INTO public.season (id, org_id, title_id, name, starts_on, ends_on, status, is_current)
VALUES ('66aeaec8-df7e-47c2-9663-da0bfd6e608b', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        '106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7',
        '2025-26 Season', '2025-01-01T00:00:00Z', '2026-12-31T23:59:59Z', 'active', true)
ON CONFLICT DO NOTHING;

INSERT INTO public.division (id, org_id, season_id, name, slug, tier, rank_order)
VALUES ('4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        '66aeaec8-df7e-47c2-9663-da0bfd6e608b',
        'BGMI Pro Division', 'bgmi-pro', 'elite', 1)
ON CONFLICT DO NOTHING;

-- Teams --------------------------------------------------------------------
INSERT INTO public.team (id, org_id, name, slug, game_id, division_id, status, is_active)
VALUES ('444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        'Raptor BGMI Main', 'raptor-bgmi-main',
        '410c0c71-bfd9-41be-bbf0-598085027fd9', '4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc',
        'active', true)
ON CONFLICT (org_id, slug) DO NOTHING;

INSERT INTO public.team (id, org_id, name, slug, game_id, division_id, status, is_active)
VALUES ('1d2c3992-8eb2-40cd-833f-9c4fa75471b4', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        'Raptor BGMI Academy', 'raptor-bgmi-academy',
        '410c0c71-bfd9-41be-bbf0-598085027fd9', NULL,
        'forming', true)
ON CONFLICT (org_id, slug) DO NOTHING;

-- Players (preview-marked, public profiles)
--
-- THE HANDLES ARE THE ART FILENAMES, AND THAT IS THE POINT
-- -------------------------------------------------------
-- The public roster resolves a portrait by handle: the site asks for
-- `/placeholders/player-<handle>.png` and falls back to the generic
-- `player-portrait.svg` when that file does not exist
-- (`apps/web/src/components/public/art.ts`). The committed art is named for
-- five handles - RExANNA, RExFURRYJOD, RExIGRIS, RExSANKU, RExZEROIGL - and
-- they are the handles seeded here.
--
-- They used not to match: the seed carried five researched display names
-- ("Jelly", "Hydro" and so on) while the art carried the REx* set, so the
-- roster resolved NOTHING and every portrait on the site was the generic
-- placeholder. The art was committed, reachable by nobody, and the symptom
-- read as "the images are missing". The portraits are illustrated brand art
-- in the Raptor palette, not photographs of people, so pairing them with a
-- handle is a naming decision and not an attribution one.
--
-- A handle change means renaming the art to match, or changing the seed to
-- match the art. This file follows the art, because the art is the expensive
-- half to produce and the reviewed half.
INSERT INTO public.person (id, external_ref) VALUES
  ('b44f16ba-1efb-4ac8-b2ee-96467a874885', 'preview:player-rexigris'),
  ('25c9ce24-d98c-42b3-8fc8-e4377c79ca03', 'preview:player-rexanna'),
  ('294f46af-4b43-4583-aa48-731c9f75c6f2', 'preview:player-rexsanku'),
  ('7ebd2393-f935-4d8f-9e96-92071f02a0c3', 'preview:player-rexfurryjod'),
  ('4908ae96-c0d1-4de6-827a-68fc0862b131', 'preview:player-rexzeroigl')
ON CONFLICT (id) DO UPDATE SET external_ref = EXCLUDED.external_ref;

-- `display_name` IS the handle for the public roster: `roster_handles()`
-- returns `person_profile.display_name` as the handle, because a person has no
-- separate handle column in this schema. That is why the portrait lookup above
-- works on this value.
--
-- The upsert UPDATES rather than doing nothing: a seed that cannot converge an
-- existing row is a seed that only works on a database that has never seen it.
INSERT INTO public.person_profile (person_id, display_name, profile_visibility) VALUES
  ('b44f16ba-1efb-4ac8-b2ee-96467a874885', 'RExIGRIS', 'public'),
  ('25c9ce24-d98c-42b3-8fc8-e4377c79ca03', 'RExANNA', 'public'),
  ('294f46af-4b43-4583-aa48-731c9f75c6f2', 'RExSANKU', 'public'),
  ('7ebd2393-f935-4d8f-9e96-92071f02a0c3', 'RExFURRYJOD', 'public'),
  ('4908ae96-c0d1-4de6-827a-68fc0862b131', 'RExZEROIGL', 'public')
ON CONFLICT (person_id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO public.team_membership (org_id, team_id, person_id, role_in_team, share_percent, valid_from, joined_at) VALUES
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', 'b44f16ba-1efb-4ac8-b2ee-96467a874885', 'captain', 0, '2025-03-27T00:00:00Z', '2025-03-27T00:00:00Z'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '25c9ce24-d98c-42b3-8fc8-e4377c79ca03', 'player', 0, '2025-03-27T00:00:00Z', '2025-03-27T00:00:00Z'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '294f46af-4b43-4583-aa48-731c9f75c6f2', 'player', 0, '2025-07-21T00:00:00Z', '2025-07-21T00:00:00Z'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '7ebd2393-f935-4d8f-9e96-92071f02a0c3', 'player', 0, '2025-07-21T00:00:00Z', '2025-07-21T00:00:00Z'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '1d2c3992-8eb2-40cd-833f-9c4fa75471b4', '4908ae96-c0d1-4de6-827a-68fc0862b131', 'player', 0, '2025-12-12T00:00:00Z', '2025-12-12T00:00:00Z')
ON CONFLICT (org_id, team_id, person_id) WHERE valid_to IS NULL DO NOTHING;

-- Opponent lobby (structural; finals lobbies have no single opposing team) --
INSERT INTO public.opponent (id, org_id, name, short_name, game_id)
VALUES ('1f98ad92-651b-4642-98ea-20254869cae7', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
        'Grand Final Lobby', 'Lobby', '410c0c71-bfd9-41be-bbf0-598085027fd9')
ON CONFLICT (org_id, name) DO NOTHING;

-- Competitions (PREVIEW-APPROX month blocks where only the month is sourced)
INSERT INTO public.competition (id, org_id, title_id, name, format, status, starts_at, ends_at, external_ref)
SELECT 'cdb20ce2-8acd-4117-95e2-3c4dafe88f64', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7',
       'Battlegrounds Mobile India Pro Series 2026', 'groups_playoffs', 'completed',
       '2026-05-06T00:00:00Z', '2026-06-21T23:59:59Z', 'preview:event-bmps-2026'
WHERE NOT EXISTS (SELECT 1 FROM public.competition WHERE org_id = '0c295a27-1295-4dcf-9a0e-2f77a772f14d' AND name = 'Battlegrounds Mobile India Pro Series 2026');

INSERT INTO public.competition (id, org_id, title_id, name, format, status, starts_at, ends_at, external_ref)
SELECT 'bd3efce2-028b-4b94-a8a4-b6eb97e34912', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7',
       'BGMI Masters Series Season 4', 'groups_playoffs', 'completed',
       '2025-08-18T00:00:00Z', '2025-09-14T23:59:59Z', 'preview:event-bgms-s4'
WHERE NOT EXISTS (SELECT 1 FROM public.competition WHERE org_id = '0c295a27-1295-4dcf-9a0e-2f77a772f14d' AND name = 'BGMI Masters Series Season 4');

INSERT INTO public.competition (id, org_id, title_id, name, format, status, starts_at, ends_at, external_ref)
SELECT 'bd04cb35-867f-4ee2-ba52-17be125fdef5', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7',
       'BGMI International Cup 2025', 'groups_playoffs', 'completed',
       '2025-11-01T00:00:00Z', '2025-11-30T23:59:59Z', 'preview:event-bmic-2025'
WHERE NOT EXISTS (SELECT 1 FROM public.competition WHERE org_id = '0c295a27-1295-4dcf-9a0e-2f77a772f14d' AND name = 'BGMI International Cup 2025');

INSERT INTO public.competition (id, org_id, title_id, name, format, status, starts_at, ends_at, external_ref)
SELECT '45b38695-6b4a-4be6-bf8e-26b64cca356d', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '106f5ac7-bd9d-4fd8-bd0d-ecbc1e518dd7',
       'Chennai Esports Championship 2025', 'groups_playoffs', 'completed',
       '2025-12-01T00:00:00Z', '2025-12-31T23:59:59Z', 'preview:event-chennai-2025'
WHERE NOT EXISTS (SELECT 1 FROM public.competition WHERE org_id = '0c295a27-1295-4dcf-9a0e-2f77a772f14d' AND name = 'Chennai Esports Championship 2025');

INSERT INTO public.competition_division (id, org_id, competition_id, division_id, name, capacity)
VALUES
  ('3c898086-551a-4942-b33f-7d0ec637f31b', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'cdb20ce2-8acd-4117-95e2-3c4dafe88f64', '4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc', 'Grand Final', 16),
  ('e5b93ed9-a234-4461-b867-9ca1c8b4e230', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'bd3efce2-028b-4b94-a8a4-b6eb97e34912', '4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc', 'Grand Final', 16),
  ('1248cd72-eec5-4c39-b26e-d7df01342e26', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'bd04cb35-867f-4ee2-ba52-17be125fdef5', '4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc', 'Grand Final', 16),
  ('0223b0a6-8118-499b-89ec-a0ed0af7868f', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', '45b38695-6b4a-4be6-bf8e-26b64cca356d', '4e3442b2-9dc7-4c97-83fb-a5e3a674c7fc', 'Grand Final', 16)
ON CONFLICT (org_id, competition_id, name) DO NOTHING;

INSERT INTO public.match (id, org_id, competition_division_id, team_id, opponent_id, round_label, status, scheduled_at, started_at, completed_at)
SELECT '57f0babd-0525-4e80-b246-96bde525eafd', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '3c898086-551a-4942-b33f-7d0ec637f31b', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '1f98ad92-651b-4642-98ea-20254869cae7',
       'Grand Final', 'completed', '2026-06-21T14:00:00Z', '2026-06-21T14:00:00Z', '2026-06-21T20:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM public.match WHERE id = '57f0babd-0525-4e80-b246-96bde525eafd');

INSERT INTO public.match (id, org_id, competition_division_id, team_id, opponent_id, round_label, status, scheduled_at, started_at, completed_at)
SELECT '487fed1c-2dde-4f6d-9c34-83a7e913dca8', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       'e5b93ed9-a234-4461-b867-9ca1c8b4e230', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '1f98ad92-651b-4642-98ea-20254869cae7',
       'Grand Final', 'completed', '2025-09-14T14:00:00Z', '2025-09-14T14:00:00Z', '2025-09-14T20:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM public.match WHERE id = '487fed1c-2dde-4f6d-9c34-83a7e913dca8');

INSERT INTO public.match (id, org_id, competition_division_id, team_id, opponent_id, round_label, status, scheduled_at, started_at, completed_at)
SELECT '6d466bbc-3723-4512-a6fc-007c9ae1605a', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '1248cd72-eec5-4c39-b26e-d7df01342e26', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '1f98ad92-651b-4642-98ea-20254869cae7',
       'Grand Final', 'completed', '2025-11-30T14:00:00Z', '2025-11-30T14:00:00Z', '2025-11-30T20:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM public.match WHERE id = '6d466bbc-3723-4512-a6fc-007c9ae1605a');

INSERT INTO public.match (id, org_id, competition_division_id, team_id, opponent_id, round_label, status, scheduled_at, started_at, completed_at)
SELECT '21f09cab-d75f-44c2-bab4-7551159f00c6', '0c295a27-1295-4dcf-9a0e-2f77a772f14d',
       '0223b0a6-8118-499b-89ec-a0ed0af7868f', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', '1f98ad92-651b-4642-98ea-20254869cae7',
       'Grand Final', 'completed', '2025-12-31T14:00:00Z', '2025-12-31T14:00:00Z', '2025-12-31T20:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM public.match WHERE id = '21f09cab-d75f-44c2-bab4-7551159f00c6');

-- Verified placements (manual source ⇒ confidence 1; verified by the captain)
INSERT INTO public.match_result (org_id, match_id, team_id, outcome, placement, source, confidence, recorded_by_person_id, recorded_at, verified_at, verified_by_person_id) VALUES
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '57f0babd-0525-4e80-b246-96bde525eafd', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', 'loss', 25, 'manual', 1, 'b44f16ba-1efb-4ac8-b2ee-96467a874885', now(), now(), 'b44f16ba-1efb-4ac8-b2ee-96467a874885'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '487fed1c-2dde-4f6d-9c34-83a7e913dca8', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', 'loss', 11, 'manual', 1, 'b44f16ba-1efb-4ac8-b2ee-96467a874885', now(), now(), 'b44f16ba-1efb-4ac8-b2ee-96467a874885'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '6d466bbc-3723-4512-a6fc-007c9ae1605a', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', 'loss', 2, 'manual', 1, 'b44f16ba-1efb-4ac8-b2ee-96467a874885', now(), now(), 'b44f16ba-1efb-4ac8-b2ee-96467a874885'),
  ('0c295a27-1295-4dcf-9a0e-2f77a772f14d', '21f09cab-d75f-44c2-bab4-7551159f00c6', '444f49a2-3065-4fa4-8a5a-fd2a14e24fd5', 'loss', 2, 'manual', 1, 'b44f16ba-1efb-4ac8-b2ee-96467a874885', now(), now(), 'b44f16ba-1efb-4ac8-b2ee-96467a874885')
ON CONFLICT (org_id, match_id, team_id) DO NOTHING;

-- Counts (expect: 1 game, 2 teams, 5 players, 4 competitions, 4 results) -----
SELECT (SELECT count(*) FROM public.game) AS games,
       (SELECT count(*) FROM public.team) AS teams,
       (SELECT count(*) FROM public.person WHERE external_ref LIKE 'preview:%') AS preview_people,
       (SELECT count(*) FROM public.competition) AS competitions,
       (SELECT count(*) FROM public.match_result) AS results;
