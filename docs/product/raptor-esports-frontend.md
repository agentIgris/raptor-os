# Raptor Esports — Complete Build Plan (Public + Workspace + Payload CMS)

## Goal
Ship three connected surfaces on the existing backend without inventing data: a public Raptor fan site (`(site)`), the preserved Raptor OS ops console plus role-aware workspace (`(app)`), and a Payload CMS admin (`/cms-admin`) owning all publishable content. One identity (Better Auth), one tenancy (`organization`), zero fabricated teams/stats/assets.

## Stack pins (install-time)
- `payload@3` + `@payloadcms/next@3` + `@payloadcms/db-postgres@3` + `@payloadcms/richtext-lexical@3` + `sharp` (exact minors pinned in `packages/cms/package.json` at install; v4 beta track is excluded).
- Mounts: admin `/cms-admin`, api `/cms-api` (Payload `routes` config — `/api/*` stays Better Auth + health/ready).
- Secrets (`.env.local` + empty entries in `.env.example`): `PAYLOAD_SECRET` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), `S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_REGION`/`S3_ENDPOINT` (Supabase S3-compatible).
- DB: Payload owns `cms_*` tables only (`dbName` prefix on every collection/global); canonical SQL + Supabase baseline never include them.

## Phase A — Payload CMS
- [x] 1. Install into new `packages/cms` (`payload.config.ts`: postgres adapter, S3 storage adapter → Supabase, Lexical, SEO fields inline, no extra plugins). Wrap `apps/web/next.config.ts` with `withPayload`; add turbo tasks `cms:generate-types`, `cms:migrate` → Verify: `/cms-admin` renders setup, `/api/auth/*` + `/api/ready` untouched, `pnpm build` green.
- [x] 2. Collections `cms_media` (upload/S3), `cms_news` (slug, Lexical, cover, draft/published + schedule), `cms_pages` (blocks), `cms_partners` + globals `cms_site_settings` (nav, socials, theme), `cms_recruitment` (open flag, form target). Every item carries `orgId`; access functions deny-by-default + org-scope; `packages/cms/provision.sql` creates runtime role `cms_app` owning `cms_*` only (migrations run as postgres, runtime as `cms_app`) → Verify: migrate creates zero non-`cms_*` tables; as `cms_app`, `SELECT` on `organization` fails and drafts are invisible.
- [x] 3. First operator account via `/cms-admin` setup; publish one draft → verify it appears publicly and the draft 404s; signed S3 media loads with sizes/focal points → Verify: public page shows published doc, draft URL 404s logged-out.

## Phase B — Public site
- [x] 4. Competitor IA notes (truerippers.gg, fireeyes.in — structure only) in the PR description → Verify: `rg -l 'truerippers|fireeyes' apps packages` returns nothing.
- [x] 5. Tokens/typography in `globals.css` (provisional neutral; condensed display stack) + extend `site-header.tsx` to the brief nav with mobile menu + per-route metadata/OG (`og-default.svg` until approved art) → Verify: axe contrast pass, 360px no-overflow, unique title/OG per route.
- [x] 6. Sections as server components, `force-dynamic`: hero (LCP `priority`), proof strip (real facts or omitted), divisions, roster, results, news (Payload Local API, published-only), recruitment (only when open), partners (only when approved). Domain reads via `raptor_app` (`division`/`team`/`match_result`/`public_site_publication`); galleries lazy; empty-states everywhere → Verify: Playwright empty-state specs; no admin/chart JS in the public bundle.

## Phase C — Workspace (+ OS preserved)
- [x] 7. `(app)` shell: sidebar (tenant mark, org switcher, role-filtered nav from `ALL_ROLES` + `org_membership`), topbar (breadcrumbs, user menu, sign out), mobile drawer; tenant switch reloads scope and clears cache. The existing prize/roster/attendance dashboard stays byte-for-byte functional → Verify: `pending` sees no ops nav; unauthenticated deep link 307s; dashboard numbers unchanged.
- [x] 8. Modules from real tables only — teams/rosters, competitions/results, members/roles, content (deep-link to `/cms-admin`), partners/obligations, people/contracts (role-gated), insights as tables (recharts only when a real metric needs it, per ADR-0009). Loading/empty/error/denied states; no client `tenantId` → Verify: division-A manager blocked from division B via UI *and* direct query.
- [x] 9. Better Auth → Payload custom strategy (`auth.strategies`): Google/session cookie maps to CMS-operator role, local passwords disabled after cutover → Verify: Google sign-in opens `/cms-admin` with correct CMS role; no second credential exists.

## Phase D — Verify
- [x] 10. `pnpm.cmd lint`, `typecheck`, `test`, `build` green; e2e at 360/768/1280px; tenant-A/B isolation; expired-session + denied-state specs; `supabase db push` dry-run clean → Verify: outputs + spec report; plan boxes ticked; blockers listed, not hidden.

## Done When
- [x] `/` is a fan site, `/dashboard` is the OS console, `/cms-admin` runs content — no invented data anywhere.
- [x] One identity, one tenancy, enforcement server-side (layout guard + RLS + Payload access); tenant never from request params.
- [x] Full gate green; `ASSET-MANIFEST.md` still all-`placeholder` until real assets land at the end.

## Research notes — competitor IA (Task 4, structure only, 2026-10-13)
- True Rippers: hero (identity + 2 CTAs) → marquee strip → rosters → trophy cabinet (year/placement/prize/game) → news (1 featured + recents) → featured videos → fan zone → brands → recruitment → newsletter → grouped footer.
- FireEyes: single-page anchors — hero → about + proof numbers → ecosystem pillars → divisions → achievements → creators → reach stats → founders → partner offers → store → schedule → contact.
- Adopted for Raptor: brief §3 order stands (hero → proof → divisions → roster → results → news → community → recruitment-conditional → partners). FireEyes' "CREATOR 1 / NO IMAGE" placeholders confirm our empty-states rule.
- Nothing copied, scraped, or hotlinked; no competitor names, URLs, images, or marks enter the repo.

## Staging content job (post-plan, 2026-10-14/15, per explicit instruction)

Preview dataset researched from public sources (Liquipedia, Esports Charts,
tournament coverage) about other Indian BGMI orgs. Staging only.

- Org `raptor` (Raptor Esports, INR, Asia/Kolkata, active) via
  `provision_organization`; `PUBLIC_ORG_ID` in env (slug lookup is RLS-gated
  and can never bootstrap — documented in `.env.local`).
- 6 role accounts (`STAGING-CREDENTIALS.md`, gitignored): verified + roles
  via SQL; owner/admin/manager staged at `player` because `user_mfa_guard`
  refuses privileged rows without TOTP (promotion path documented in the
  credentials file). Persons/profiles(`org`-visible)/links/active memberships
  included. CMS operator remapped to `owner@raptor.local` (strategy match).
- Content: `scripts/preview-seed.sql` (idempotent, `preview:` markers on
  persons/competitions; month blocks flagged PREVIEW-APPROX) → 1 game,
  2 teams, 5 public players, 4 competitions, 4 verified results; 3 CMS news
  articles published via the operator session (covers with no uploads yet).
- Held lines (deliberate, not deferred): NO partners (endorsement
  implications), NO player photos (consent), recruitment closed, socials
  empty, NO demo seed in the canonical migrations (preview lives in
  `scripts/`, outside the migration ledger).
- Migrations added along the way: `0015_cms_operator_session.sql` (strategy
  bridge), `0016_public_roster_reads.sql`
  (`roster_handles()`/`person_directory()` — the service-layer read path
  `0001` anticipates for RLS-less profile tables), each with a Supabase
  mirror + push. Both proved live (strategy login, id-only negative,
  `permission denied` negative).
- Reliability fixes from live fire: pool `min: 1` + one idempotent retry
  (dead-idle slots), shared Payload singleton + 20s init guard,
  role-level `statement_timeout = 15s` (WARP blackholes stalled streams),
  driver date normalization (`toISODate`/`toDateTime` — pg returns `Date`,
  `.slice` on it tripped the route error boundary).
- Replacement duty: delete `preview:` persons/competitions + CMS preview
  articles, or the whole dataset, when verified Raptor facts land. Real
  onboarding (invite accept → `auth_set_active_org`) is the remaining open
  product gap; Resend mail is WIRED (see below), not worked around.
- Mail (RESOLVED): `packages/auth/src/email.ts` sends verification + reset
  mail through Resend (`RESEND_API_KEY`/`EMAIL_FROM`, onboarding-sender
  default = test-mode restricted); former no-op senders replaced; 4 unit
  tests; live-proven against the real API (reset request accepted, HTTP
  200 end to end).

## Decisions & credentials needed- **Seed (RESOLVED 2026-10-13): no demo seed, ever.** Sections distinguish unknown (`null`: DB unreachable or org missing) from known-empty (`[]`) with designed copy for each; e2e asserts both with no database. Demo rows would violate the no-fabrication rule and are rejected, not deferred.
- **Tenant address** (slug/subdomain/domain) — one scheme only. Task 6 ships `PUBLIC_ORG_SLUG` (default `raptor`) as the explicit single-org mechanism.
- **From you:** Supabase S3 access key (dashboard) for Task 1; Raptor assets at the end (logo/palette first); WARP/IPv6 on during dev.
- **Known issue (Task 9, cosmetic):** operator rows serialize id-only via Payload REST (`/me`, doc reads) while news docs serialize fully — root cause not yet isolated (ruled out: collection access, field access, drizzle mapping of other collections). AuthN/AuthZ unaffected (presence-based + function data). Next step: upstream minimal repro. Cutover stands.
- **Local env gap (found + fixed 2026-10-13):** Next reads `apps/web/.env*`, not repo-root `.env.local` — plain `pnpm dev` booted with empty env. Fixed without secret duplication: `pnpm dev:local` (`scripts/dev-env.mjs`) loads root env into the dev processes; `--check` validates names-only.
- **Stall guard (2026-10-14):** WARP IPv6 path to Mumbai occasionally blackholes mid-query, and pg has no statement timeout by default — one stuck SELECT stalled the whole streamed page forever. Fixed at the role level (survives reconnects, covers all present and future code): `ALTER ROLE raptor_app/cms_app SET statement_timeout = '15s'`. Worst case now degrades to designed unknown-states, never a hung skeleton. App pools keep one warm connection each (`min: 1`) + one idempotent retry; CMS reads share one Payload instance per process with a 20s init guard.
