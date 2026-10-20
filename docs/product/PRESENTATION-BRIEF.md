# Raptor OS — Pitch & Presentation Brief

## The problem
Running an esports organisation today means juggling spreadsheets for
rosters, chat apps for coordination, scattered files for contracts, and a
separate website that goes stale within weeks. Nothing agrees with anything
else: prize payouts can't be traced, nobody knows who is allowed to do what,
and fans see last season's roster.

## The solution
**Raptor OS** — one operating system for the whole organisation:
- **One backend** every team, player, match, rupee and document lives in,
  with strict data separation between organisations.
- **A public fan website** that updates itself from that backend: divisions,
  rosters, verified results, news.
- **A workspace console** where each role (owner, manager, coach, player…)
  sees exactly their part: teams, competitions, members, content, analytics.
- **A content admin (CMS)** where editors publish news and media — logging
  in with the same account as everywhere else.

## Key features
- Multi-tenant by design: many organisations, one deployment, zero data leaks.
- Verified results only: every placement carries its source and verifier.
- Prize engine: allocations computed by audited rules, reconciliation proven.
- Role-based access + two-factor authentication for privileged accounts.
- Google sign-in, email verification, password resets that actually log
  attackers out.
- Draft → publish workflow: unpublished content is invisible to the public.

## How it was built
1. Planned the data model first: organisation → games → divisions → teams →
   players; competitions → matches → verified results; money → allocations.
2. Chose a boring-reliable stack: Next.js 16, PostgreSQL 17 (Supabase Cloud),
   Better Auth, Payload CMS 3, Tailwind/shadcn, Resend mail.
3. Built backend before screens: 100+ tables with row-level security, so the
   database itself refuses cross-tenant access.
4. Built the CMS content plane on least-privilege database roles.
5. Built the fan site and workspace on top — both read the same live data.
6. Verified everything: lint, type checks, 500+ automated tests, 94 browser
   checks including accessibility (WCAG 2.2 AA), plus live security probes.

## Live demo path (3 minutes)
1. `/` — fan site: proof strip, division, rosters, verified results table.
2. `/sign-in` — log in as coach; open `/teams` and `/members`.
3. `/cms-admin` — same login; publish a story, watch it appear on `/`.
4. `/dashboard` — prize reconciliation console.

## Roadmap
- Real Raptor roster, results and brand assets replacing preview content.
- Player mobile view, match-day live centre, merchandise store.
- Second organisation onboarding to prove multi-tenancy end to end.

## Stack (one line)
Next.js 16 · Supabase Postgres 17 · Better Auth + Google · Payload CMS 3 ·
Tailwind/shadcn · Resend · pnpm + Turborepo · Playwright + Vitest.
