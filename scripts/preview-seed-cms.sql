-- scripts/preview-seed-cms.sql - STAGING PREVIEW CONTENT. Never production.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The preview CONTENT of the fan site - the news, the partner strip, the
-- recruitment panel, the site settings and the social links - used to exist
-- only inside `scripts/db-local-snapshot/raptor_os.pgdump`, a binary blob.
-- That is a bad place for content to live, and it fails in a way that is
-- easy to miss:
--
--   * a fresh clone that ran `pnpm bootstrap` (the documented one-command
--     setup) got the DOMAIN preview data - teams, games, players,
--     competitions, results - and NO news, no partners and no site settings,
--     because `scripts/preview-seed.sql` seeds the domain and nothing seeded
--     the `cms_*` tables. The content was in the snapshot, so only the path
--     that restored the snapshot could see it;
--   * the content was unreviewable: no diff, no history, no way to see what
--     changed without restoring a whole database;
--   * it was invisible to every test, because it was data, not code.
--
-- So the content is a SEED now, and the snapshot is what it always should
-- have been: a portable COPY of a database this file can recreate.
--
-- WHAT IT SEEDS
-- -------------
--   cms_news                  three published stories
--   cms_partners              five partners, by tier, marked DEMO-SEED-001
--   cms_recruitment           the open-tryouts panel
--   cms_site_settings         the site name, tagline and default SEO
--   cms_site_settings_socials four official channel links
--   cms_operators             owner@raptor.local and admin@raptor.local, so the
--                             CMS admin console can be signed into
--
-- WHAT IT IS NOT
-- -------------
--   - Not endorsements: the partners are invented, their URLs are
--     `example.com`, and every row carries the marker `DEMO-SEED-001`.
--   - Not photos: every image column is NULL. The art is the committed
--     placeholder set in `apps/web/public/placeholders/`, which is in git
--     and therefore travels with the clone. There is no uploaded media in
--     this seed and nothing to restore.
--   - Not secrets: the `cms_operators` rows carry an email and a role and
--     NO password hash. The CMS authenticates with the same Better Auth
--     session as the product (see `cms_operator_session()`), so there is no
--     CMS password to store here.
--
-- IDEMPOTENT: every statement is guarded with ON CONFLICT, and the identity
-- sequences are resynced at the end because this file inserts explicit ids.
-- Apply as: postgres (the superuser bypasses RLS; the app role could never
-- write these tables, which is the point of RLS).
-- ORDER: after the Payload migrations, because the tables have to exist.
-- REPLACEMENT DUTY: delete the rows carrying the `preview:` slugs and the
-- `DEMO-SEED-001` marker the day verified Raptor facts land.
--
-- The enum casts below name Payload's own types (`enum_cms_news_status` and
-- friends), which are NOT the column names. A cast written from the column
-- name fails on a fresh database with `type "cms_news_status" does not
-- exist`, and passes everywhere else only because the type is nowhere else
-- used.

-- News ---------------------------------------------------------------------
INSERT INTO public.cms_news (id, title, slug, excerpt, body, published_at, org_id, seo_title, seo_description, _status)
VALUES (3, 'Runners-up at the BGMI International Cup 2025', 'preview-bmic-2025-runners-up', 'Second place in the November international final.', '{"root":{"type":"root","format":"","indent":0,"version":1,"children":[{"type":"paragraph","format":"","indent":0,"version":1,"children":[{"mode":"normal","text":"The squad closed out November with a second-place finish at the BGMI International Cup 2025, holding the top two from the final day.","type":"text","style":"","detail":0,"format":0,"version":1}],"direction":"ltr"}],"direction":"ltr"}}'::jsonb, '2025-11-30T00:00:00.000Z', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', NULL, NULL, 'published'::public.enum_cms_news_status)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, body = EXCLUDED.body, published_at = EXCLUDED.published_at, seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, _status = EXCLUDED._status;

INSERT INTO public.cms_news (id, title, slug, excerpt, body, published_at, org_id, seo_title, seo_description, _status)
VALUES (4, 'Second place at the Chennai Championship', 'preview-chennai-2025-second', 'Back-to-back finals to close out 2025.', '{"root":{"type":"root","format":"","indent":0,"version":1,"children":[{"type":"paragraph","format":"","indent":0,"version":1,"children":[{"mode":"normal","text":"December brought another grand-final appearance at the Chennai Championship 2025, ending the year second on the stage.","type":"text","style":"","detail":0,"format":0,"version":1}],"direction":"ltr"}],"direction":"ltr"}}'::jsonb, '2025-12-31T00:00:00.000Z', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', NULL, NULL, 'published'::public.enum_cms_news_status)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, body = EXCLUDED.body, published_at = EXCLUDED.published_at, seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, _status = EXCLUDED._status;

INSERT INTO public.cms_news (id, title, slug, excerpt, body, published_at, org_id, seo_title, seo_description, _status)
VALUES (5, 'Pro Series 2026 campaign ends 25th', 'preview-bmps-2026-25th', 'A quarter-final exit in June.', '{"root":{"type":"root","format":"","indent":0,"version":1,"children":[{"type":"paragraph","format":"","indent":0,"version":1,"children":[{"mode":"normal","text":"The Pro Series 2026 run ended in 25th place after the June finals week. Work for the next split starts now.","type":"text","style":"","detail":0,"format":0,"version":1}],"direction":"ltr"}],"direction":"ltr"}}'::jsonb, '2026-06-21T00:00:00.000Z', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', NULL, NULL, 'published'::public.enum_cms_news_status)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, body = EXCLUDED.body, published_at = EXCLUDED.published_at, seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, _status = EXCLUDED._status;

-- Partners ----------------------------------------------------------------
INSERT INTO public.cms_partners (id, name, url, tier, agreement_ref, org_id, _status)
VALUES (1, 'Nordbyte Peripherals', 'https://example.com/nordbyte-peripherals', 'title'::public.enum_cms_partners_tier, 'DEMO-SEED-001', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'published'::public.enum_cms_partners_status)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, tier = EXCLUDED.tier, _status = EXCLUDED._status;

INSERT INTO public.cms_partners (id, name, url, tier, agreement_ref, org_id, _status)
VALUES (2, 'Vireo Mobile', 'https://example.com/vireo-mobile', 'gold'::public.enum_cms_partners_tier, 'DEMO-SEED-001', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'published'::public.enum_cms_partners_status)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, tier = EXCLUDED.tier, _status = EXCLUDED._status;

INSERT INTO public.cms_partners (id, name, url, tier, agreement_ref, org_id, _status)
VALUES (3, 'Quantum Quest Energy', 'https://example.com/quantum-quest-energy', 'silver'::public.enum_cms_partners_tier, 'DEMO-SEED-001', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'published'::public.enum_cms_partners_status)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, tier = EXCLUDED.tier, _status = EXCLUDED._status;

INSERT INTO public.cms_partners (id, name, url, tier, agreement_ref, org_id, _status)
VALUES (4, 'Hexaforge Studios', 'https://example.com/hexaforge-studios', 'community'::public.enum_cms_partners_tier, 'DEMO-SEED-001', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'published'::public.enum_cms_partners_status)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, tier = EXCLUDED.tier, _status = EXCLUDED._status;

INSERT INTO public.cms_partners (id, name, url, tier, agreement_ref, org_id, _status)
VALUES (5, 'Lumen Cloud', 'https://example.com/lumen-cloud', 'community'::public.enum_cms_partners_tier, 'DEMO-SEED-001', '0c295a27-1295-4dcf-9a0e-2f77a772f14d', 'published'::public.enum_cms_partners_status)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, tier = EXCLUDED.tier, _status = EXCLUDED._status;

-- Recruitment -------------------------------------------------------------
INSERT INTO public.cms_recruitment (id, open, heading, body, form_target)
VALUES (1, true, 'Raptor tryouts are open', '{"root":{"type":"root","format":"","indent":0,"version":1,"children":[{"type":"paragraph","format":"","indent":0,"version":1,"children":[{"mode":"normal","text":"We are scouting for the BGMI Pro Division roster: entry-fraggers, support anchors and a flex. Trials run on weekends; shortlisted players get scrim blocks against the main squad.","type":"text","style":"","detail":0,"format":0,"version":1}],"direction":"ltr"}],"direction":"ltr"}}'::jsonb, 'https://example.com/raptor/apply')
ON CONFLICT (id) DO UPDATE SET open = EXCLUDED.open, heading = EXCLUDED.heading, body = EXCLUDED.body, form_target = EXCLUDED.form_target;

-- Site settings -----------------------------------------------------------
INSERT INTO public.cms_site_settings (id, site_name, tagline, default_seo_title, default_seo_description)
VALUES (1, 'Raptor Esports', 'Competitive BGMI roster from India — squads, results and open trials.', 'Raptor Esports — BGMI Pro Division', 'Raptor Esports is an Indian BGMI organisation competing in the Pro Division. Follow the roster, results, open trials and official channels.')
ON CONFLICT (id) DO UPDATE SET site_name = EXCLUDED.site_name, tagline = EXCLUDED.tagline, default_seo_title = EXCLUDED.default_seo_title, default_seo_description = EXCLUDED.default_seo_description;

-- Social links ------------------------------------------------------------
INSERT INTO public.cms_site_settings_socials (_order, _parent_id, id, network, url)
VALUES (0, 1, 'raptor_x', 'x'::public.enum_cms_site_settings_socials_network, 'https://x.com/raptoresports')
ON CONFLICT (id) DO UPDATE SET _order = EXCLUDED._order, network = EXCLUDED.network, url = EXCLUDED.url;

INSERT INTO public.cms_site_settings_socials (_order, _parent_id, id, network, url)
VALUES (1, 1, 'raptor_instagram', 'instagram'::public.enum_cms_site_settings_socials_network, 'https://instagram.com/raptoresports')
ON CONFLICT (id) DO UPDATE SET _order = EXCLUDED._order, network = EXCLUDED.network, url = EXCLUDED.url;

INSERT INTO public.cms_site_settings_socials (_order, _parent_id, id, network, url)
VALUES (2, 1, 'raptor_youtube', 'youtube'::public.enum_cms_site_settings_socials_network, 'https://youtube.com/@raptoresports')
ON CONFLICT (id) DO UPDATE SET _order = EXCLUDED._order, network = EXCLUDED.network, url = EXCLUDED.url;

INSERT INTO public.cms_site_settings_socials (_order, _parent_id, id, network, url)
VALUES (3, 1, 'raptor_discord', 'discord'::public.enum_cms_site_settings_socials_network, 'https://discord.gg/raptoresports')
ON CONFLICT (id) DO UPDATE SET _order = EXCLUDED._order, network = EXCLUDED.network, url = EXCLUDED.url;

-- CMS operators ------------------------------------------------------------
INSERT INTO public.cms_operators (id, role, email) VALUES (1, 'owner'::public.enum_cms_operators_role, 'owner@raptor.local')
ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO public.cms_operators (id, role, email) VALUES (2, 'editor'::public.enum_cms_operators_role, 'admin@raptor.local')
ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role;

-- Sequences -----------------------------------------------------------------
-- This file inserts EXPLICIT ids, so the identity sequences are still sitting at
-- their start value: the next row Payload creates would take id 1 and collide
-- with the row above. The resync is the difference between a seed that works
-- once and a seed that works forever.
SELECT setval(pg_get_serial_sequence('public.cms_news', 'id'), COALESCE((SELECT max("id") FROM public."cms_news"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('public.cms_partners', 'id'), COALESCE((SELECT max("id") FROM public."cms_partners"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('public.cms_recruitment', 'id'), COALESCE((SELECT max("id") FROM public."cms_recruitment"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('public.cms_site_settings', 'id'), COALESCE((SELECT max("id") FROM public."cms_site_settings"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('public.cms_operators', 'id'), COALESCE((SELECT max("id") FROM public."cms_operators"), 0) + 1, false);

-- Verify --------------------------------------------------------------------
-- The counts this file is expected to produce. A line that is not here is a
-- line that is missing content, not a line that is fine.
SELECT (SELECT count(*) FROM public.cms_news)                 AS news,
       (SELECT count(*) FROM public.cms_partners)             AS partners,
       (SELECT count(*) FROM public.cms_recruitment)          AS recruitment,
       (SELECT count(*) FROM public.cms_site_settings)        AS site_settings,
       (SELECT count(*) FROM public.cms_site_settings_socials) AS socials,
       (SELECT count(*) FROM public.cms_operators)            AS operators;
